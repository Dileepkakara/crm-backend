# Design Blocks CRM API

Node.js, Express, and MongoDB API for the existing React frontend. The API is mounted at `/api/v1`. The frontend uses this backend by default. To use the clearly separated local demo data, explicitly set `VITE_API_MODE=mock`.

## Setup

1. Install Node.js 20 or newer and run MongoDB as a replica set (transactions are used for payment posting and lead conversion).
2. Copy `.env.example` to `.env` and replace the JWT secret with a cryptographically random value. Set MongoDB and the frontend origin. In `frontend`, copy `.env.example` to `.env.local` and set `VITE_API_BASE_URL` to the reachable API URL. Vite environment variables are public configuration and must never contain credentials or secrets.
3. From this directory, run `npm install`, then `npm run dev`.
4. Create the first administrator in a trusted terminal, not through a public registration route:

   ```powershell
   $env:SUPER_ADMIN_NAME = "CRM Administrator"
   $env:SUPER_ADMIN_EMAIL = "admin@example.com"
   $env:SUPER_ADMIN_PASSWORD = "use-a-unique-long-password"
   npm run seed:admin
   Remove-Item Env:SUPER_ADMIN_NAME
   Remove-Item Env:SUPER_ADMIN_EMAIL
   Remove-Item Env:SUPER_ADMIN_PASSWORD
   ```

### Configure a local MongoDB replica set on Windows

CRM record creation, updates, audit logging, lead conversion, and payment workflows use MongoDB transactions. A standalone MongoDB server rejects these operations. If MongoDB is installed as a Windows service:

1. Back up the MongoDB configuration file, then edit the existing `mongod.cfg` (commonly under `C:\Program Files\MongoDB\Server\<version>\bin\`). Preserve its current storage settings and add:

   ```yaml
   replication:
     replSetName: rs0
   ```

2. In an elevated PowerShell window, restart the service (confirm the service name first with `Get-Service *Mongo*`):

   ```powershell
   Restart-Service MongoDB
   ```

3. Initialize the replica set once, then verify it:

   ```powershell
   mongosh --eval "rs.initiate()"
   mongosh --eval "rs.status().ok"
   ```

   The status command should return `1`. Do not change the existing MongoDB data directory.

4. Add `replicaSet=rs0` to the `MONGODB_URI` in `backend/.env`, for example `mongodb://127.0.0.1:27017/design_blocks?replicaSet=rs0`, then restart the CRM API.

When MongoDB rejects a transaction because it is running standalone, the API responds with `503 REPLICA_SET_REQUIRED` rather than a generic server error.

The seed command is idempotent for the configured email, refuses to elevate an existing non-administrator, and refuses to create another initial Super Admin when one already exists. Legacy `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and optional `SEED_ADMIN_NAME` variables remain supported. Do not use demo credentials in a deployed environment.

If the initial Super Admin password is forgotten, reset it from a trusted terminal. Set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` (the password must be at least 12 characters), then run `npm run reset:admin-password`. This only resets an existing active Super Admin, revokes existing sessions, and requires a password change at next sign-in.

After seeding, sign in through the frontend login page with the configured Super Admin email and password. An authorized Super Admin creates employee and linked client accounts in **Users & access**. New accounts use a temporary password and must change it at first sign-in; administrators can reset an account password from that page. Signed-in users can change their own password from the profile menu. Password changes require the current password and sign the user out. No forgot-password flow is provided because no email or OTP provider is configured.

## Authentication and response contract

Login returns a short-lived bearer access token and sets a rotating, HTTP-only refresh cookie. Keep the access token in memory; the frontend refreshes the cookie-backed session after a page reload. Logout and password changes revoke the stored refresh token and invalidate current access tokens. Configure HTTPS in production. Password changes require the current password; there is no password recovery email provider configured.

Successful responses use `{ "success": true, "data": ... }`; errors use `{ "success": false, "error": { "code", "message", "requestId" } }`. List endpoints return the array under `data` and pagination information under `meta`.

All amounts are recalculated on the server using decimal arithmetic and rounded to two decimal places. The current GST percentages are accepted as document inputs and validated, but no statutory tax rates are configured by default. Payment posting and lead conversion require MongoDB transaction support.

## Initial policy decisions

- Role identifiers match the current frontend values (`super_admin`, `director`, `sales_manager`, `sales_executive`, `accounts`, `project_manager`, `developer`, and `client`).
- Clients may view only their own records; developers may view/update only assigned tasks and related projects; other employee scoping follows the frontend permission matrix.
- A project may be created from an accepted work order and duplicate creation is blocked. Manual project creation remains available to project managers because that is supported by the existing UI. No advance-payment prerequisite is enforced until the business defines a milestone/payment policy.
- Manual payment records are recorded as authorized internal entries, not gateway-verified transactions. Refunds are represented by status/audit history and do not trigger an external payment.
- Work-order acceptance is an audited acknowledgement, not a cryptographic or legally certified electronic signature.
- Notifications are stored in-app. No email, WhatsApp, SMS, file storage, or payment-gateway provider is configured.

## API overview

- Auth: `/auth/login`, `/auth/logout`, `/auth/refresh`, `/auth/me`, `/auth/password`
- User management: `/users`
- Role management: `/roles` (Super Admin only; built-in roles are read-only, custom roles are stored in MongoDB)
- CRM: `/leads`, `/followups`, `/clients`, `/quotations`, `/agreements`, `/invoices`, `/payments`, `/projects`, `/tasks`, `/notifications`
- Transitions: `/leads/:id/convert`, `/quotations/:id/{send,approve,reject,revise}`, `/agreements/:id/{submit,accept}`, `/invoices/:id/issue`, `/projects/from-agreement/:agreementId`, `/payments/:id/refund`, `/tasks/:id/comments`
- Portal and analytics: `/portal`, `/dashboard`, `/reports`
- Company preferences: `/settings/company`

See `src/routes` and `src/validation` for the exact request contract.

Super Admins manage custom roles from **Users & access**. Custom role permissions are loaded from the API and evaluated server-side on each authenticated request, so permission edits take effect without changing user documents. The privileged `users.manage`, `roles.manage`, and `settings.manage` permissions are reserved for built-in Super Admins and cannot be assigned to custom roles. A custom role cannot be deactivated while any user is assigned to it; reassign those users first. Built-in role definitions are system-managed and remain available.
