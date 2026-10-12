#### Components Needed
- [ ] The module that implements the feature, under `{{paths.source}}`
- [ ] Its exported surface (types and functions) declared explicitly
- [ ] Registration with whatever dispatches to it (router, command table, DI container)
- [ ] Input schemas at the boundary
- [ ] Configuration, if the feature needs any
- [ ] Tests under `{{paths.tests | default("tests")}}`
- [ ] Documentation

#### Patterns to Apply (MANDATORY)
- [ ] Follow the registration pattern this project already uses — mirror the nearest
      existing feature rather than inventing a second shape
- [ ] Resolve configuration through this project's config loader
- [ ] `{{verify.type | default("declare verification.LANG.type in massu.config.yaml")}}` must pass with no new errors
- [ ] Release every resource you acquire — close what you open, in a `finally`
