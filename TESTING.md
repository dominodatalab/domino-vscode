# Testing

This document describes the test suite for the Domino Data Lab VS Code extension, including how to run the tests, how they are structured, and what each suite covers.

## Running the Tests

```bash
# Run the full test suite (lint + tests)
npm test

# Run tests only, skipping lint
npx jest

# Run tests in watch mode during development
npx jest --watch

# Run tests with a coverage report
npx jest --coverage
```

Coverage output is written to `coverage/` and includes an HTML report at `coverage/lcov-report/index.html`.

---

## How Testing Works

### Framework

Tests use [Jest](https://jestjs.io/) with [ts-jest](https://kulshekhar.github.io/ts-jest/) for TypeScript compilation. There is no need to compile the project before running tests — ts-jest handles that automatically.

### VS Code Mock

The extension imports the `vscode` module extensively, but that module only exists inside the VS Code runtime. For unit testing, it is replaced by a lightweight mock at `src/__mocks__/vscode.ts`.

The mock provides stub implementations of the VS Code APIs used by this extension:

| Mock export | What it stands in for |
|---|---|
| `TreeItem` | Base class for all sidebar tree nodes |
| `TreeItemCollapsibleState` | Enum controlling expand/collapse state |
| `ThemeIcon` / `ThemeColor` | Icons and color tokens in the UI |
| `MarkdownString` | Rich tooltip content |
| `EventEmitter<T>` | The publisher half of VS Code's event system |
| `Uri` | Resource identifiers |
| `env`, `window`, `workspace`, `commands` | VS Code extension host globals |

Jest is configured in `jest.config.js` to redirect any `import ... from 'vscode'` to this mock via `moduleNameMapper`.

### Injecting Dependencies

None of the modules under test are loaded through the VS Code extension host lifecycle (`activate` / `deactivate`). Instead, each test file constructs the class under test directly and supplies mock collaborators.

For classes that use the `DominoApiClient`, tests create a plain JavaScript object with `jest.fn()` methods and pass it to the constructor. For `DominoApiClient` itself, the private `httpClient` field is set directly using a type cast to `any`, which avoids the need to run the full `authenticate()` flow (which involves real HTTP calls and OAuth) in unit tests.

---

## Test Files

### `src/test/auth.test.ts`

Tests the OAuth2 PKCE authentication helpers in `src/auth.ts`.

The VS Code `SecretStorage` interface is mocked with a plain object using `jest.fn()`. Axios HTTP calls are mocked at the module level with `jest.mock('axios')`.

**`refreshAccessToken`**
- Posts to the Keycloak token endpoint with the correct grant type, client ID, and refresh token
- Maps the response into a `TokenSet` with an updated `expiresAt` timestamp
- Falls back to the old refresh token when the server response omits a new one (some Keycloak configurations do not rotate refresh tokens)

**`revokeTokens`**
- Posts to the Keycloak revocation endpoint with the refresh token
- Does **not** throw when the revocation request fails — sign-out should always succeed locally even if the server is unreachable

**`storeTokens` / `loadTokens` / `clearTokens`**
- `storeTokens` serializes the `TokenSet` to JSON before writing to `SecretStorage`
- `loadTokens` parses the stored JSON back into a `TokenSet`; returns `null` when nothing is stored or when the stored value is malformed
- `clearTokens` calls `delete` on the storage key

---

### `src/test/dominoApiClient.test.ts`

Tests the business logic in `src/dominoApiClient.ts`. The private `httpClient` field is replaced with a mock object before each test, so no real HTTP requests are made.

**Initial state**
- `isAuthenticated` is `false` before `authenticate()` has been called
- `currentProjectId` and `currentProjectName` are `null`

**`clearAuth`**
- Resets `httpClient`, `accessToken`, `apiUrl`, `currentProjectId`, and `currentProjectName` to their defaults

**`apiHost` getter**
- Extracts the hostname from a valid URL (e.g., `https://domino.example.com/path` → `domino.example.com`)
- Returns the raw string value when the URL cannot be parsed

**`setCurrentProject`**
- Sets `currentProjectId` and `currentProjectName`
- Sets `currentProjectName` to `null` when no name argument is provided

**`updateAccessToken`**
- Updates the internal access token that is injected into every request header

**`getJobs` — pagination**

The Domino API uses page numbers rather than offsets. `getJobs` must convert the `offset` / `limit` parameters into the correct `page_no` query parameter using `Math.floor(offset / limit) + 1`.

| offset | limit | expected page_no |
|--------|-------|-----------------|
| 0 | 20 | 1 |
| 20 | 20 | 2 |
| 40 | 10 | 5 |

The `hasMore` flag is also derived here: `hasMore = (offset + jobs.length) < total`. Tests verify both the `true` and `false` cases, and that an empty/null API response is handled gracefully.

**`getWorkspaces` — owner filtering**

The API returns all workspaces for a project, but the sidebar should only show workspaces owned by the currently authenticated user. `getWorkspaces` calls `getSelf()` to get the current user's ID and then filters the list by `ownerId`. Tests cover:
- The primary array response format
- The `{ workspaces: [...] }` response format
- The `{ data: [...] }` response format
- An empty/unrecognized response
- An HTTP error (returns `[]` rather than throwing)

**`getHardwareTiers` — transformation**

The API returns hardware tiers in a nested structure (`{ hardwareTier: { hwtResources: { cores, memory } } }`). `getHardwareTiers` flattens this into a simpler shape and filters out tiers where `hwtFlags.isVisible` is `false`. Tests verify the transformation and the visibility filter, and confirm that a sensible set of default tiers is returned when the endpoint 404s.

**`getEnvironments` — deduplication and archiving**

The `useableEnvironments` endpoint returns a `currentlySelectedEnvironment` separately from the `environments` array, which may contain it as a duplicate. Tests verify:
- The currently selected environment appears first with `isDefault: true`
- It is not duplicated even when it also appears in the `environments` array
- Environments where `archived: true` are excluded from the result
- A plain array response format (from fallback endpoints) is also handled

---

### `src/test/projectProvider.test.ts`

Tests the `ProjectProvider` tree data provider in `src/projectProvider.ts`, which drives the Projects sidebar.

**`getChildren` (root level)**
- Returns an empty array when there are no projects
- Groups projects into `OwnerItem` nodes by `ownerUsername`
- Sorts owner groups alphabetically
- Shows the project count in each `OwnerItem`'s description (e.g., `"2 projects"`)
- Falls back to `"Unknown"` when `ownerUsername` is absent
- Returns an empty array (rather than throwing) when the API call fails

**`getChildren` (owner level)**
- Returns `ProjectItem` nodes for the given owner
- Each `ProjectItem` has `contextValue = "project"` (required for context menu wiring in `package.json`)
- Each `ProjectItem` has `collapsibleState = None` (projects are leaf nodes)

**`refresh`**
- Clears the cached `projectsByOwner` map so the next `getChildren` call re-fetches from the API

---

### `src/test/jobProvider.test.ts`

Tests the `JobProvider` tree data provider in `src/jobProvider.ts`, which drives the Jobs sidebar.

**`refresh`**
- Resets `currentOffset` to `0`, clears the `jobs` array, and resets `hasMore` and `total` to their defaults
- This ensures that the next render starts from the first page rather than appending to stale data

**`loadMore`**
- Increments `currentOffset` by `pageSize` (20) on each call
- Calling it twice increments by 40 total

**`getChildren` — unauthenticated**
- Returns an empty array when `isAuthenticated` is `false`

**`getChildren` — no project selected**
- Returns a prompt header (`"Select a project…"`) and a `"Start New Job"` action item when no project has been selected

**`getChildren` — empty job list**
- Shows a `"No jobs found"` header, the `"Start New Job"` action button, and a help text item

**`getChildren` — with jobs**
- A fresh load (offset = 0) replaces the jobs array rather than appending
- The rendered list contains a summary header, the action button, and one item per job
- Each job item has `contextValue = "job"` (required for context menu wiring)
- The item label matches the job's `title` field
- The summary header contains the total count
- A `"Load More"` item with `contextValue = "loadMore"` is appended when `hasMore` is `true`
- No `"Load More"` item appears when `hasMore` is `false`
- Subsequent pages (offset > 0) append to the existing jobs array rather than replacing it

**Time-ago formatting**
- Jobs completed less than 60 minutes ago show `"Xm ago"` in the item description
- Jobs completed more than 60 minutes ago show `"Xh ago"`
- Jobs with only a `runStartTime` (i.e., currently running) show `"running"`

**Error handling**
- When the API call throws, the provider returns a safe error message rather than propagating the exception

---

### `src/test/workspaceProvider.test.ts`

Tests the `WorkspaceProvider` tree data provider in `src/workspaceProvider.ts`, which drives the Workspaces sidebar.

**`getChildren` — unauthenticated**
- Returns an empty array

**`getChildren` — no project selected**
- Returns a single `"Select a project…"` header item

**`getChildren` — empty workspace list**
- Returns a `"No workspaces found"` header and a `"Create New Workspace"` action item

**`getChildren` — with workspaces**
- The top of the list contains a summary header and the create action before the workspace items
- The summary text reports running and stopped counts separately (e.g., `"2 workspaces • 1 running • 1 stopped"`)

**Workspace `contextValue`** controls which context menu buttons appear in `package.json`:

| Workspace state | Active SSH tunnel | `contextValue` |
|---|---|---|
| `Started` or `Running` | No | `workspace-running` |
| `Started` or `Running` | Yes | `workspace-running-ssh` |
| Anything else | — | `workspace-stopped` |

- When a tunnel is active, the SSH port number also appears in the item's `description` string (e.g., `"Started • by alice • SSH :2222"`)

**Error handling**
- When the API call throws, the provider returns a safe error message rather than propagating the exception

---

## CI

Tests run automatically via GitHub Actions:

- **On every push to any branch** — lint and tests run via `.github/workflows/ci.yml`
- **On every PR** — same workflow runs against the PR branch
- **On push to `main`** — `.github/workflows/publish.yml` packages the extension as a `.vsix` file and uploads it as a build artifact (marketplace publishing is currently disabled; see that file for instructions on enabling it)
