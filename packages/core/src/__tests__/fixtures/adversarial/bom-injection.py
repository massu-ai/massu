from fastapi import Depends

def x():
    Depends(safe_dep)
