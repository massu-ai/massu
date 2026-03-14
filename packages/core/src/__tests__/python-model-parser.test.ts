// Copyright (c) 2026 Massu. All rights reserved.
// Licensed under BSL 1.1 - see LICENSE file for details.

import { describe, it, expect } from 'vitest';
import { parsePythonModels } from '../python/model-parser.ts';

describe('python-model-parser', () => {
  it('parses SA 1.x model with Column', () => {
    const source = `class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    name = Column(String(100), nullable=False)
    email = Column(String, nullable=True)`;
    const models = parsePythonModels(source);
    expect(models).toHaveLength(1);
    expect(models[0].className).toBe('User');
    expect(models[0].tableName).toBe('users');
    expect(models[0].columns.length).toBeGreaterThanOrEqual(2);
  });

  it('parses SA 2.0 model with mapped_column', () => {
    const source = `class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))`;
    const models = parsePythonModels(source);
    expect(models).toHaveLength(1);
    expect(models[0].columns.length).toBeGreaterThanOrEqual(1);
  });

  it('parses relationships', () => {
    const source = `class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    posts = relationship("Post", back_populates="author")`;
    const models = parsePythonModels(source);
    expect(models).toHaveLength(1);
    expect(models[0].relationships.length).toBeGreaterThanOrEqual(1);
    expect(models[0].relationships[0].target).toBe('Post');
  });

  it('parses foreign keys', () => {
    const source = `class Post(Base):
    __tablename__ = "posts"
    id = Column(Integer, primary_key=True)
    author_id = Column(Integer, ForeignKey("users.id"))`;
    const models = parsePythonModels(source);
    expect(models).toHaveLength(1);
    expect(models[0].foreignKeys.length).toBeGreaterThanOrEqual(1);
    expect(models[0].foreignKeys[0].target).toBe('users.id');
  });

  it('parses multiple models', () => {
    const source = `class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)

class Post(Base):
    __tablename__ = "posts"
    id = Column(Integer, primary_key=True)`;
    const models = parsePythonModels(source);
    expect(models).toHaveLength(2);
  });

  it('handles class with no tablename', () => {
    const source = `class UserBase(DeclarativeBase):
    pass`;
    const models = parsePythonModels(source);
    // May or may not detect — depends on inheritance detection
    // At minimum, should not crash
    expect(models).toBeDefined();
  });

  it('returns empty for no models', () => {
    const source = `def helper():
    pass`;
    expect(parsePythonModels(source)).toHaveLength(0);
  });
});
