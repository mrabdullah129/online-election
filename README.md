# Secure Online Election Management System

React + Supabase semester project for authenticated election creation, voter opt-in, voter finalization, secret ID based anonymous voting, live results, dashboards, audit logs, and deployment.

## Features

- React/Vite frontend with responsive public election board.
- Role-based flows for Super Admin, Election Creator, and Voter.
- Creator approval request, approval/rejection reason, and email queue simulation.
- Election creation with category, dates, registration deadline, max voters, publish, start, stop, and result lock actions.
- Candidate management with photo, designation, and manifesto fields.
- Voter registration, terms acceptance, duplicate registration prevention, waitlist, auto locking, final voter list, and masked secret IDs.
- Secret ID voting with one voter = one vote enforcement and anonymous ballot logs.
- Live candidate-wise results, turnout percentage, winner details, Recharts charts, and PDF result export.
- Audit and transparency dashboard with downloadable logs.
- Dark mode bonus feature.
- Supabase schema with RLS policies and server-side functions for voter finalization and vote casting.

## Demo Accounts

Use the Access page buttons:

- Super Admin: approvals, overrides, logs.
- Election Creator: create elections, add candidates, finalize voters, start/stop elections.
- Voter: join polls, view masked secret IDs, cast votes.

The app runs in local demo mode until Supabase environment variables are added.

## Setup

```bash
npm install
npm run dev
```

PowerShell may block `npm.ps1` on some Windows machines. If that happens, use:

```bash
npm.cmd install
npm.cmd run dev
```

Open the Vite URL shown in the terminal.

## Supabase Setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. Copy `.env.example` to `.env`.
4. Add:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key
```

5. Restart the dev server.

The current UI is demo-first, but `src/lib/supabase.js` is ready for real Supabase Auth calls. The SQL file includes:

- `profiles`, `creator_requests`, `elections`, `candidates`, `voter_registrations`, `anonymous_votes`, `audit_logs`, and `notifications`.
- RLS policies for admins, creators, voters, and public published elections.
- `finalize_election(election_id)` to lock voters and generate hashed secret IDs.
- `cast_vote(election_id, candidate_id, secret_code)` to validate a secret ID and store an anonymous vote.

If an existing Supabase project shows `function digest(text, unknown) does not exist`, `Invalid secret ID`, or votes do not cast after finalization, run `supabase/fix-vote-rpc.sql` in the Supabase SQL editor. It updates the vote RPC and stores the issued secret-ID ordinal so voters see the exact backend-validated secret ID.

## Deployment On Vercel

1. Push the project to GitHub.
2. Import the repository in Vercel.
3. Add the same Supabase environment variables in Vercel project settings.
4. Build command: `npm run build`.
5. Output directory: `dist`.

## Suggested Presentation Flow

1. Show the public landing page with active, upcoming, and completed elections.
2. Sign in as Super Admin, approve or reject a creator request, and download logs.
3. Sign in as Election Creator, create a draft election, add candidates, publish, finalize voters, and start/stop voting.
4. Sign in as Voter, join an election, use the issued secret ID, and cast one anonymous vote.
5. Show live results, turnout, winner details, result PDF, audit logs, and the Supabase RLS schema.
