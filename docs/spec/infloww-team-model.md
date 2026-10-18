# Infloww team model: employees, chatters, roles, invites (from shipped artifacts)

Written 2026-10-17. Read-only reverse engineering. Complements [infloww-definitions.md](infloww-definitions.md) (§4 attribution, §5 shifts).
O = observed in code or strings. I = inferred. U = unknown.

## Sources

- **D**: desktop shell `/Applications/Infloww.app/Contents/Resources/app.asar` v5.7.20 (sha256 4f75ee9e…). REA
  `analyze_javascript_application` evidence `ev_542543753c5f…` (parent `ev_8b250e276f12…`). Main process is bytenode
  (`dist/main/main.jsc`), so only its strings were read. Preload: `dist/preload/index.js`, `dist/preload/hooks/useFeatureInfo.js`.
- **W**: the real CRM UI is a remote web app, `https://embed-remote-web.infloww.com/38236048582/assets/index.b50b8e61.js`
  (17 MB, sha256 ee4b9139…). Recovered from Chromium's HTTP cache under `~/Library/Application Support/infloww/Partitions/*/Cache`.
  Searched as text; not run through REA.
- **L**: English i18n module `…/38236048582/assets/index.71e6a68b.js` (sha256 3454de7f…). It is javascript-obfuscator
  output, so it was decoded in a Node `vm` sandbox with no `require`, giving 2606 keys.

## 1. Account model

- **O** One login equals one employee record in one agency. `POST /login` sends `{email, password, recaptcha…, clientVersion, need2FA:true}`
  (W `LoginForm`: the only form fields are `email` and `password`). The response holds a single
  `{agency:{agencyId,name,logo,email}, accessToken, refreshToken, employeeId, name, email, unid, roles, gmtCreate}`
  (W `onLoginSuccess`). There is no agency picker and no list of agencies.
- **O** The owner is created at agency signup: `POST /agency/register {type:"Agency", name, owner:{name,email,password,validCode}, token}`,
  after `POST /agency/validcode {email}`.
- **O** Every other user is an **employee created by the agency**: name, email, group, roles and creators. The agency
  never sets a password. Infloww emails a verification/activation link and the employee sets their own password
  (details in §2).
- **O** Employee `type`: `0` is the owner/super-admin, and `1` is admin-level, protected from non-owners. The list page
  hides row actions when `row.type===0 || (row.type===1 && me.type!==0)` (W `EmployeeListPage`). Other values: U.
  Login status code 1100 carries `superManager`. That flag is what selects the "pay to unblock" flow.
- **O** Employee `status`: `0` Inactive (not verified yet; shows a "Resend" link), `1` Activated, `7`/`8` Deactivated
  (`isDeactivated=S=>S===7||S===8`).
- **O/I** "Internal" vs "external": **no such concept ships.** Searches of W and L found no internal/external employee
  types, no invite-an-existing-user flow and no join/accept-agency flow. The only "invite" strings belong to S4S
  invite links and the affiliate/referral programme (`/growth/invitation/*`, `/affiliate/*`). So Infloww supports
  exactly one model: agency-provisioned, email-identified sub-accounts, each with its own password.
- **I** The login lookup is by email alone, so an email most likely maps to one employee record globally. A person
  who works for two agencies would then need two emails. U: whether the backend allows one email in several agencies.

## 2. Add employee / activation flow (the "invite")

- **O** `POST /employee/add` takes `{name (≥3 chars, [0-9a-zA-Z_ -], ≤50), email, division (group path), roleIds, recaptchaToken…}`
  with `retryTimes:0`. The response `data` is the new employeeId. The client then calls
  `POST /employee/update/creator {employeeId, creatorIds}` and `POST /employee/update/role {employeeId, roleIds}`
  (W `AddModelComponent$3`). Success string (L `employee0227`): "{{name}} successfully added to Infloww. A verification
  email has been sent to the employee's inbox." Status 1118 is the employee seat limit ("You have reached your employee
  account limit…"). Status 1078 means recaptcha failed.
- **O** The activation page reads `?token=`. It validates with `GET /account/activate?token=` and then posts
  `POST /account/activate {token, password (6–30), timezone "+HH:MM"}`, redirecting to /login (W `ActivePage`).
- **O** Resend: `POST /employee/resend {employeeId}` (L `employee0008`/`0072`). Shown only while status is 0.
- **O** "Revoke": there is no invite object to revoke. The options are `PATCH /employee/disable {employeeId}`,
  `PATCH /employee/enable`, and `DELETE /employee/delete?employeeId=&employeeIds=` ("Any data related to this employee
  will be deleted and cannot be recovered", L `employee0247`).
- **O** Admin password reset is `POST /account/forgotPassword {email, recaptcha}`, gated by `Employees_ResetPassword`.
  An agency-level 2FA switch exists: `/agency/2fa/setting|get`.
- **U** Token expiry. An invitee who already has an account is not a case, since no invite object exists.

## 3. Roles and permissions

- **O** Roles are **custom, agency-defined**:
  - `/role/list`, `/role/listRoles`, `/role/select/list`
  - `POST /role/add`
  - `POST /role/edit {roleName, description, roleId}`
  - `POST /role/delete {roleId}` (fails when in use: "This role is in use and cannot be deleted")
  - `POST /role/status/modify {roleId, status}`
  - `GET /role/permission/view/v3?roleId=`
  - `POST /role/permission/set {roleId, rolePermissions}`

  An employee can hold **several roles** (multi-select).
- **I** There is a built-in "Chatter" role. The evidence: `GET /employee/chatter/list` and the "Show only employees
  with Chatter role" filter (L `employee0168`). U: the full preset list, which is server-side.
- **O** Permission tree node shape: `{menu, menuName, menuEnable, functionMenu, permissionLimit, hidden, type (0=GENERAL or a platform), functionPermissions:[{function, functionName, functionEnable}], dataRangeLimit, dataRangeFollows, dataPermission:{type, specialEmployee[], specialModel[]}, children}`.
  Each platform (OF, Fansly, MYM, Fanvue) gets its own tab.
- **O** Data scope per menu (`dataPermission.type`): `0` All data, `1` Self and subordinates, `2` Data about self
  (L `settings0015/0162/0043`). Subordinates means the employee-group (division) tree.
- **O** Function permission IDs (W `FUN_PERMISSIONS$1`, 230 entries). Selected keys:
  - **Messages**: SendMessage 7, MessagesQueue 8, MassMessage 10, MassMessagesStatics 9, MessageOnlineFans 140,
    OFMassMessages 212/Unsent 213, PriorityMassMessage create 215/terminate 216/unsend 217/stats 214, AutoMessage
    218–220, MuteChat 402, RestrictUser 403, AddEditNotes 404, Black 416.
  - **Vault**: ViewList 13, Categories 14, DeleteVault 15, AddToCategory 16. GrowthVault 380–387.
  - **Statements** 26, **Statistics** 27, HomePage 1, Overview 41/42, CreatorsPerformance 43, ChattingReports
    122/123/124 plus Reassign 178/Remove 179 Sales, FansReports 46, SalesRecords 180–183.
  - **Creator-account settings**: OFSettings 31–40 (Profile, Account, Privacy, SubscriptionPriceAndBundles 34, …),
    MyProfile 28–30, NewPost 2–5, Lists 22–25, Queue 18–21.
  - **Team**: CreatorsManagement 52–56, GROUP 168–170. Employees: ViewList 57, Add 58, Edit 59, Delete 60,
    DisableActive 61, ResetPassword 62, AssignCreators 63, SetUpRoles 64, Add/Edit/DeleteGroup 65–67.
    RolePermissions 76–81. ShiftsScheduling 68/127–130, ShiftsRecords 71/72/199/1991/197/198, SalesSettings 125/126.
  - **Scripts** 110–114/477/47xx, SmartTags/Lists, SensitiveWords 191–196, Wallet 87–91, Billing 86/118/119/519,
    AI Assistant 310/511–515, AIChatbot 530/531/534, promotions/trial/tracking links 150–167/50xx.
  - **Home dashboard cards** (second enum): ORGANIZATION_DATA 752, AGENCY_REVENUE_CARD 6222 … EMPLOYEE_LEADERBOARD_CARD
    6230, CLOCKED_EMPLOYEES_CARD 6232. These are the earnings-visibility controls.
- **O** Client gating: `GET /permission/view` and `GET /account/info/v2`, then `appFunctionPower.auth(id)`.
- **O** Creator access is assigned **per employee per creator**: `POST /employee/update/creator {employeeId, creatorIds}`.
  The picker also groups by creator tag/group (`/creator/group/*`). Shifts grant access too: "Scheduling them for this
  shift will grant them access to the Creator" (L `employee0151`), and `employees_assigned_creators` auto-assigns.
  The list of visible creators is `GET /model/permission/bind/list?dataPermissionType=&creatorIds=`.
- **O** Employee groups are a hierarchical tree:
  - `/accountDivision/tree[/v2]`
  - `POST /accountDivision/add`
  - `POST /accountDivision/edit`
  - `POST /accountDivision/delete {path}`

  Each employee has exactly one `division` path. The tree drives "Self and subordinates".
- **O** Shifts: `/shift/v2/*` (query, scheduling create/check/delete, period, used), `/service-shift-schedule/shift/*`,
  clock in/out `/sign/*` (`query_online_employee`, `query_signStatus`, `set_config`).

## 4. Endpoints (base `https://api2.infloww.com` / `api3`; headers `Authorization: Bearer`, `X-AGENCY-ID`, `X-EMPLOYEE-ID`, unid)

| Purpose | Call |
|---|---|
| List (paged) | `GET /employee/query?requireTotal=true&…` |
| List (simple) | `GET /employee/list?dataPermissionType=` ; chatters `GET /employee/chatter/list` |
| Create | `POST /employee/add {name,email,division,roleIds,recaptcha}` |
| Edit | `PUT /employee/update {employeeId,name,email,division,roleIds}` |
| Roles | `POST /employee/update/role {employeeId,roleIds}` |
| Creators | `POST /employee/update/creator {employeeId,creatorIds}` |
| Resend activation | `POST /employee/resend {employeeId}` |
| Activate | `GET /account/activate?token=` → `POST /account/activate {token,password,timezone}` |
| Disable / enable | `PATCH /employee/disable|enable {employeeId}` |
| Delete | `DELETE /employee/delete?employeeId=&employeeIds=` |
| Role CRUD / perms | `/role/add|edit|delete|status/modify`, `/role/permission/view/v3`, `/role/permission/set` |
| Groups | `/accountDivision/tree|add|edit|delete` |

## 5. Multiple agencies and the switcher

- **O** There is no server-side workspace switcher. The desktop app keeps a **local multi-account list**. Each entry is
  `{agencyId, employeeId, agencyName, employeeName, employeeEmail, agencyEmail, logo, token, refreshToken, unid, status}`
  (W `onLoginSuccess` and `updateAccount`; D preload `GET_ACCOUNT_INFO` → `accountList.find(e=>e.employeeId===employeeId)`;
  main.jsc strings include `accountList`, `switchAccount`, `switchToNewAccountMainWindow`).
- **O** The avatar menu shows "Add/switch account" (L `header_avatar_002`). The modal lists each account as employee
  name over agency name, with actions Switch, "New window" and Remove. "Add new account" runs a normal email/password
  login. Expired refresh tokens show "Log in required". Logging in again to the same employeeId shows "You are already
  signed in to this Infloww account on this device."
- **I** So a person in two agencies has two separate employee logins, and the desktop app lets them sit side by side
  and be switched between. They are not one identity with several memberships.

## Gaps

U: preset role list and default permissions (server-side); activation token TTL; whether an email can exist in two
agencies; meaning of employee type values above 1. Confirming these needs runtime capture or the help centre.
