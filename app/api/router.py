from __future__ import annotations

from fastapi import APIRouter

from app.api.batch_import import router as batch_import_router
from app.api.bundle import router as bundle_router
from app.api.config import router as config_router
from app.api.discogs import router as discogs_router
from app.api.events import router as events_router
from app.api.jobs import router as jobs_router
from app.api.playlist import router as playlist_router
from app.api.qr import router as qr_router
from app.api.queue import router as queue_router
from app.api.search import router as search_router
from app.api.setlists import router as setlists_router
from app.api.stems import router as stems_router
from app.api.transcribe import router as transcribe_router
from app.api.versions import router as versions_router

router = APIRouter()
router.include_router(config_router, tags=["config"])
router.include_router(jobs_router, prefix="/jobs", tags=["jobs"])
router.include_router(versions_router, prefix="/jobs", tags=["jobs"])
router.include_router(transcribe_router, prefix="/jobs", tags=["jobs"])
router.include_router(events_router, tags=["events"])
router.include_router(stems_router, tags=["stems"])
router.include_router(bundle_router, tags=["bundle"])
router.include_router(qr_router, tags=["qr"])
router.include_router(queue_router, prefix="/queue", tags=["queue"])
router.include_router(playlist_router, prefix="/playlist", tags=["playlist"])
router.include_router(batch_import_router, prefix="/import", tags=["import"])
router.include_router(search_router, prefix="/search", tags=["search"])
router.include_router(discogs_router, prefix="/discogs", tags=["discogs"])
router.include_router(setlists_router, prefix="/setlists", tags=["setlists"])
