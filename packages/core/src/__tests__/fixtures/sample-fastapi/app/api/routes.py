from fastapi import APIRouter, Depends
from app.core.deps import get_db, get_current_user
from app.models import User

router = APIRouter()

@router.get("/users", response_model=list)
async def list_users(db=Depends(get_db)):
    return []

@router.get("/users/{user_id}")
async def get_user(user_id: int, db=Depends(get_db)):
    pass

@router.post("/users")
async def create_user(db=Depends(get_db), user=Depends(get_current_user)):
    pass

@router.delete("/users/{user_id}")
async def delete_user(user_id: int, user=Depends(get_current_user)):
    pass
