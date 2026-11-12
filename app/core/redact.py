"""Stripping locally- or personally-identifying text before it can reach a
public report.

The notification centre's "Report on GitHub"/"Report on Discord" flow and its
opt-in "include recent logs" button both end with this text pasted somewhere
public. Four things in particular have no business being there:

  - The reporter's home directory. On Windows the Python install path alone
    (`C:\\Users\\<name>\\...`) carries the OS username.
  - A track's source URL. `download.py` logs it for every job
    ("download starting: <url>"), so a raw log tail carries the YouTube/
    SoundCloud link for everything the reporter has ever imported in the
    fetched window -- not just the one that failed. The per-job failure
    report has always kept this out deliberately (see
    app/api/jobs.py's _FAILURE_PUBLIC_KEYS); a raw log has no such allowlist
    of its own, so it is enforced here instead.
  - An IP address. The mobile UI talks to this backend over the LAN when
    network access is on, so uvicorn's access log (captured into
    backend.log on desktop) can carry another device's address on the
    reporter's home network, not just their own.
  - A line of the cookies file. yt-dlp writes a line it cannot parse to
    stderr, which is backend.log on desktop, and into the job's error; that
    line is the user's YouTube session.

Paths are matched in any spelling a log carries them in (either slash,
doubled backslashes from repr(), any case) and replaced by a placeholder
that says which folder it was, so the rest of the path stays readable. The
user name is only removed as a whole path segment: replacing the bare word
would rewrite every word that contains it, and a short or common name would
shred the whole log.

Every place that can hand text to that report flow -- the per-job failure
evidence (runner.py), the Settings -> Logs viewer and the Export logs zip
(main.py) -- redacts through this one function rather than each carrying
its own copy.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.core.config import CACHE_DIR, DATA_DIR, JOBS_DIR, MODELS_DIR

# Mirrors app/pipeline/download.py's _YOUTUBE_HOSTS | _SOUNDCLOUD_HOSTS. Kept
# as a literal copy rather than importing it: this module is used from
# main.py's request path, and pipeline.download pulls in yt_dlp, which is not
# something a log-tail redaction pass should need to import.
_SOURCE_URL_RE = re.compile(
    r"https?://(?:[\w-]+\.)*"
    r"(?:youtube\.com|youtu\.be|youtube-nocookie\.com|soundcloud\.com)\S*",
    re.IGNORECASE,
)

# IPv4 only. The app's own LAN detection (app/main.py's _is_lan_ipv4) is
# IPv4-only too, and a loose IPv6 pattern is a real hazard here: something
# like "(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}" also matches an HH:MM:SS
# timestamp (every log line has one), which would mangle every line's time
# instead of catching the rare home IPv6 address.
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# yt-dlp's "skipping cookie file entry due to {e}: {line!r}" and
# http.cookiejar's "invalid Netscape format cookies file {name!r}: {line!r}".
_COOKIE_LINE_RE = re.compile(
    r"(skipping cookie file entry|invalid Netscape format cookies file)[^\r\n]*"
)

# Patterns start on a plain character, lookbehinds and ignore-case after it:
# leading ones stop the scan skipping ahead.
_SEP = r"[\\/]+"
# Not glued to a name before it: /data, but not the end of /srv/data.
_AT_START = r"(?<![\w.~-].)"
# The segment ends here: jobs and "jobs." ending a sentence, not jobs2 or jobs.json.
_AT_END = r"(?![\w-]|\.\w)"
# One path segment, not ending on a dot (Windows forbids that) so a full stop
# stays. It stops at a space; _USERS_NAME is the spaced form.
_SEGMENT = r"[^\\/\s\"'<>|:*?]*[^\\/\s\"'<>|:*?.]"
_NAME_WORD = r"[^\\/\s\"'<>|:*?;]*[^\\/\s\"'<>|:*?;.]"
# Names longer than this many extra words are rare: a longer run is message text.
_MAX_EXTRA_NAME_WORDS = 2
# A Windows or macOS user name (John Smith) up to where a path, a quote, a ";"
# or the line ends; otherwise its first word, as Linux names hold no spaces.
_USERS_NAME = (
    rf"(?:{_NAME_WORD}(?: +{_NAME_WORD}){{0,{_MAX_EXTRA_NAME_WORDS}}}"
    rf"(?=\.?(?:[\\/\"';\r\n]|$))|{_SEGMENT})"
)
# Anyone's home, not only this process's. The drive letter must not end a
# word, so https://users/... is not a drive.
_WIN_HOME_RE = re.compile(
    rf"[A-Za-z](?<!\w.):{_SEP}(?i:Users|Documents and Settings){_SEP}{_USERS_NAME}"
)
# Also the WSL, MSYS and Cygwin spellings of a Windows drive.
_POSIX_HOME_RE = re.compile(
    rf"/{_AT_START}(?:(?:mnt/|cygdrive/)?[a-z]/)?(?:Users/{_USERS_NAME}|home/{_SEGMENT})"
)
_USERS_FOLDERS = frozenset({"users", "home", "documents and settings"})
_HOME = "<home>"
_JOBS = "<jobs>"
_CACHE = "<cache>"
_MODELS = "<models>"
_DATA = "<data>"
_USER = "<user>"
_UNC = "<unc>"
_IP = "<ip>"
_SOURCE_URL = "<source-url-redacted>"
_COOKIE_LINE = "<cookie-line-redacted>"

# The lookbehind keeps a URL's // and a repr() path's doubled separator
# (C:\\StemDeck\\jobs) from reading as a network share.
_UNC_RE = re.compile(rf"[\\/](?<![\w:\\/].)[\\/]+(?:\?[\\/]+UNC[\\/]+)?{_SEGMENT}[\\/]+{_SEGMENT}")


def _path_re(path: Path) -> re.Pattern[str]:
    """`path` in either slash, any case, with repr()'s doubled backslashes,
    from a segment start to a segment end."""
    head, *rest = re.split(r"[\\/]+", str(path))
    # head is the drive (C:), or empty for a POSIX root or a UNC share.
    if head:
        start = rf"[{head[0].upper()}{head[0].lower()}]{_AT_START}{re.escape(head[1:])}{_SEP}"
    else:
        # Only the first separator of a run may start a match; otherwise
        # every slash in a long run rescans the rest of it (quadratic).
        start = r"[\\/](?<![\w.~\\/-].)[\\/]*"
    return re.compile(rf"{start}(?i:{_SEP.join(map(re.escape, rest))}){_AT_END}")


def redact(text: str) -> str:
    """Strip the app's folders, any user's home folder and name, network
    shares, any YouTube/SoundCloud source URL, any IPv4 address and any
    cookies file line from `text`."""
    text = _COOKIE_LINE_RE.sub(rf"\1 {_COOKIE_LINE}", text)
    home = Path.home()
    folders = [
        (JOBS_DIR, _JOBS),
        (CACHE_DIR, _CACHE),
        (MODELS_DIR, _MODELS),
        (DATA_DIR, _DATA),
        (home, _HOME),
    ]
    # Longest first, so a folder inside another (jobs inside data, anything
    # inside home) keeps its own name.
    for folder, placeholder in sorted(folders, key=lambda f: len(str(f[0])), reverse=True):
        if folder.name:
            text = _path_re(folder).sub(placeholder, text)
    text = _WIN_HOME_RE.sub(_HOME, text)
    text = _POSIX_HOME_RE.sub(_HOME, text)
    text = _UNC_RE.sub(_UNC, text)
    # Only a home inside a users folder is named after the user; /root or
    # /github/home would turn every /home in the log into <user>.
    if home.parent.name.lower() in _USERS_FOLDERS:
        text = re.sub(rf"([\\/])(?i:{re.escape(home.name)}){_AT_END}", rf"\1{_USER}", text)
    text = _SOURCE_URL_RE.sub(_SOURCE_URL, text)
    text = _IPV4_RE.sub(_IP, text)
    return text
