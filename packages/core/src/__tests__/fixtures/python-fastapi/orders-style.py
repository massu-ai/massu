from fastapi import APIRouter, Depends
from .deps import require_tier_or_guardian

router = APIRouter(prefix="/api/options", tags=["options"])


@router.get("/list")
async def list_options(user: dict = Depends(require_tier_or_guardian)):
    return []
