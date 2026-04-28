from fastapi import APIRouter, Depends
from .auth import get_current_user

router = APIRouter(prefix="/api/users")


@router.get("/me")
async def me(user = Depends(get_current_user)):
    return {"id": user["id"]}
