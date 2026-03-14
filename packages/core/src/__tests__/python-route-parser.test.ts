// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { parsePythonRoutes } from '../python/route-parser.ts';

describe('python-route-parser', () => {
  it('parses simple GET route', () => {
    const source = `@app.get("/users")
async def get_users():
    return []`;
    const routes = parsePythonRoutes(source);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'GET', path: '/users', functionName: 'get_users' });
  });

  it('parses POST route with path param', () => {
    const source = `@router.post("/users/{user_id}/items")
async def create_item(user_id: int):
    pass`;
    const routes = parsePythonRoutes(source);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: 'POST', path: '/users/{user_id}/items' });
  });

  it('extracts response_model', () => {
    const source = `@app.get("/users/{id}", response_model=UserResponse)
async def get_user(id: int):
    pass`;
    const routes = parsePythonRoutes(source);
    expect(routes).toHaveLength(1);
    expect(routes[0].responseModel).toBe('UserResponse');
  });

  it('extracts Depends() dependencies', () => {
    const source = `@app.get("/items")
async def get_items(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    pass`;
    const routes = parsePythonRoutes(source);
    expect(routes).toHaveLength(1);
    expect(routes[0].dependencies).toContain('get_db');
    expect(routes[0].dependencies).toContain('get_current_user');
  });

  it('infers authentication from auth-related depends', () => {
    const source = `@app.get("/protected")
async def protected_route(user: User = Depends(get_current_user)):
    pass`;
    const routes = parsePythonRoutes(source);
    expect(routes).toHaveLength(1);
    expect(routes[0].isAuthenticated).toBe(true);
  });

  it('handles multiple routes', () => {
    const source = `@app.get("/a")
def route_a():
    pass

@app.post("/b")
def route_b():
    pass

@app.delete("/c")
def route_c():
    pass`;
    const routes = parsePythonRoutes(source);
    expect(routes).toHaveLength(3);
  });

  it('handles non-async def', () => {
    const source = `@app.get("/sync")
def sync_route():
    pass`;
    const routes = parsePythonRoutes(source);
    expect(routes).toHaveLength(1);
    expect(routes[0].functionName).toBe('sync_route');
  });

  it('returns empty for no routes', () => {
    const source = `def helper():
    pass

class Foo:
    pass`;
    expect(parsePythonRoutes(source)).toHaveLength(0);
  });
});
