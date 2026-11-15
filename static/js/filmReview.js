// Review: the filmed take's camera file played in step with the song. The song
// clock leads; the video is moved onto it whenever it drifts past a frame.

const DRIFT_PLAYING_SEC = 0.08;
const DRIFT_PAUSED_SEC = 1 / 60;

let loadedUrl = null;

/** Point the review video at `url`, or empty it. */
export function loadReview(video, url) {
  if (!video || url === loadedUrl) return;
  loadedUrl = url;
  video.pause();
  if (url) {
    video.src = url;
    video.load();
  } else {
    video.removeAttribute("src");
    video.load();
  }
}

function seekTo(video, sec, tolerance) {
  if (Math.abs(video.currentTime - sec) > tolerance) video.currentTime = sec;
}

/** Per frame: where the picture is at song time `songSec`; hidden outside the camera file. */
export function syncReview(video, { songSec, cameraStartSec, playing }) {
  if (!video || !loadedUrl || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
  const at = songSec - cameraStartSec;
  const inside = at >= 0 && at <= video.duration;
  video.classList.toggle("is-outside", !inside);
  if (!inside || !playing) {
    if (!video.paused) video.pause();
    if (inside) seekTo(video, at, DRIFT_PAUSED_SEC);
    return;
  }
  seekTo(video, at, DRIFT_PLAYING_SEC);
  if (video.paused) {
    video.play().catch(function onReviewPlayRefused(err) {
      console.warn("[film] review video would not play:", err);
    });
  }
}
