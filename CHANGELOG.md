# Changelog

## [2.0.1](https://github.com/AllanOps/Clean-Backend/compare/v2.0.0...v2.0.1) (2026-08-12)


### Bug Fixes

* detect control characters in the content scanner ([f653356](https://github.com/AllanOps/Clean-Backend/commit/f6533568d0336793edb9da8ec906e63868bec150))

## [2.0.0](https://github.com/AllanOps/Clean-Backend/compare/v1.0.0...v2.0.0) (2026-07-23)


### ⚠ BREAKING CHANGES

* field-limited responses, validation at the boundary, idempotency keys, graceful degradation, and intention-revealing naming are removed from the skill. Pin v1 if you depend on their presence.

### Features

* rewrite the skill around measured evidence ([9cc7cc7](https://github.com/AllanOps/Clean-Backend/commit/9cc7cc7ab7d1bb0b12e2cf11179f516657ab854b))

## 1.0.0 (2026-07-22)

### BREAKING CHANGES

* the skill file moved and its name changed from 'Backend skill' to 'clean-backend'; manual copies must be re-installed from the new skills/clean-backend/ path.

### Features

* **docs:** Add BACKEND.md with 12 backend best practices ([445f89b](https://github.com/AllanOps/Clean-Backend/commit/445f89bfc3af4ca1000b01f3d3e0d3715957af0a))
* **docs:** Add metadata section to BACKEND.md ([f190d44](https://github.com/AllanOps/Clean-Backend/commit/f190d4410412d573416ac857663b5c8022f099a5))
* repackage as a Claude Code plugin ([a9cb4ae](https://github.com/AllanOps/Clean-Backend/commit/a9cb4aef1c375e1bbd4f6413a99db7081ef84a42))

### Bug Fixes

* **Backend:** wording in BACKEND.md for clarity ([238eb7b](https://github.com/AllanOps/Clean-Backend/commit/238eb7b727a42bcb560c91318f32ba575431efc5))
* **Backend:** wording in BACKEND.md for clarity ([b3a3267](https://github.com/AllanOps/Clean-Backend/commit/b3a326745d2d85cd8ac62f25f5fe412490c41e2a))
* **docs:** Correct number of backend tricks in BACKEND.md ([a26a9fa](https://github.com/AllanOps/Clean-Backend/commit/a26a9faaa06b59862482418fbe174db13d08fee6))
* **docs:** Correct typo in BACKEND.md ([1c50ac8](https://github.com/AllanOps/Clean-Backend/commit/1c50ac8a0f14ec49a7766a2c90d4c831def0ff08))
* **docs:** Remove redundant trailing whitespace from BACKEND.md ([ed88f74](https://github.com/AllanOps/Clean-Backend/commit/ed88f74f58c79233a43bc654b98314e3c68e2ac9))
