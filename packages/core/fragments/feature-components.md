#### Components Needed
- [ ] The module that implements the feature, under `{{paths.source}}`
- [ ] Its public entry point, exported where this project's other modules are
- [ ] Registration with whatever dispatches to it (router, CLI, event handler, DI container)
- [ ] Input validation at the boundary
- [ ] Configuration, if the feature needs any
- [ ] Tests under `{{paths.tests | default("tests")}}`
- [ ] Documentation

#### Patterns to Apply (MANDATORY)
- [ ] Follow the registration pattern this project already uses — find the nearest
      existing feature and mirror it rather than inventing a second shape
- [ ] Resolve configuration through this project's config loader, not by reading files ad hoc
- [ ] Release every resource you acquire (connections, handles, locks)
- [ ] Every error path either handles the error or propagates it — never swallows it
