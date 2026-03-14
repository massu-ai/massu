from fastapi import FastAPI, Depends
from app.api.routes import router
from app.core.deps import get_db

app = FastAPI()
app.include_router(router, prefix="/api")

@app.get("/health")
async def health_check():
    return {"status": "ok"}
