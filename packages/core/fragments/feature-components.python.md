#### Components Needed
- [ ] The module that implements the feature, under `{{paths.source}}`
- [ ] Its public names exported in the package `__init__.py`
- [ ] Registration with the application (router include, CLI entry point, task registry)
- [ ] Request/response models for the boundary
- [ ] Settings, if the feature needs configuration
- [ ] Tests under `{{paths.tests | default("tests")}}`
- [ ] Docstrings on every public function

#### Patterns to Apply (MANDATORY)
- [ ] Follow the registration pattern this project already uses — mirror the nearest
      existing feature rather than inventing a second shape
- [ ] Type hints on every public signature; `{{verify.type | default("declare verification.LANG.type in massu.config.yaml")}}` must pass
- [ ] Context managers for anything that must be closed
- [ ] Never bare `except:` — catch the exception you mean
