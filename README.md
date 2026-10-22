# Gather voice rooms

Gather is an audio-only event and voice-chat app built with Vite, React, Firebase Authentication/Firestore, and LiveKit Cloud. Members can join an event room and speak concurrently; there is no video UI or video publishing permission. Event creators begin as moderators and can invite members, nominate additional moderators, mute/unmute participants, and start or stop audio-only recordings.

## Requirements

- Node.js 24.12+
- A Firebase project with Email/Password Authentication enabled and Cloud Firestore created
- A LiveKit Cloud project
- An AWS S3 bucket and credentials for LiveKit Egress recordings and playback
- A Gmail account and Google OAuth credentials for SMTP invitation emails
- A Firebase Admin service account (or another Application Default Credentials setup) for the API server

## Configure and run

1. Copy `.env.example` to `.env`.
2. Fill in the Firebase web app values (`VITE_FIREBASE_*`), server Firebase project ID, LiveKit Cloud URL/key/secret, S3 recording values, and Gmail OAuth settings. The Firebase web app values must all come from the same Firebase project.
3. Set `GOOGLE_APPLICATION_CREDENTIALS` to your service-account JSON file path. Keep the file outside source control.
4. In Firebase Console, enable **Authentication → Sign-in method → Email/Password**, create Cloud Firestore, and deploy the rules in `firestore.rules`.
5. Install dependencies with `npm install`.
6. Run `npm run server` and `npm run dev` in separate terminals.
7. Visit `http://localhost:5173`, create an account, then create a gathering. Invitees with accounts are added to the gathering and emailed a link. People without accounts receive a signup link; they must register using the invited email address to accept it.

The API uses the Vite development proxy for `/api`; in production, serve the built frontend and API behind the same origin or configure an equivalent proxy. Keep LiveKit and Firebase Admin secrets on the server only. The Firebase client config is public by design; access is constrained by Authentication and Firestore rules.

## Invitation email

Invitation email is sent through `smtp.gmail.com` with OAuth2 (XOAUTH2); the Gmail password is never stored or used. In Google Cloud Console, create an OAuth client ID for a **Web application**, configure the OAuth consent screen, and add the Gmail account as a test user if the consent screen is in testing mode. Add this redirect URI to the client:

```text
https://developers.google.com/oauthplayground
```

Open [Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground), select the gear icon, enable **Use your own OAuth credentials**, and enter the OAuth client ID and secret. In Step 1, request the scope `https://mail.google.com/`; in Step 2, authorize as the sending Gmail account and exchange the code for tokens. Copy the **refresh token** (not the access token) into `GOOGLE_OAUTH_REFRESH_TOKEN`. Keep the OAuth client secret and refresh token private; configure these values only in the API server environment.

Set `GMAIL_USER` to the Gmail account used to authorize, for example `mcameron2909@gmail.com`. `GMAIL_FROM_NAME` controls the display name; Gmail sends from the authenticated account address. A refresh token issued while the consent screen is in **Testing** can expire after seven days for Gmail scopes. For ongoing use, publish/configure the OAuth consent screen appropriately and follow Google's verification requirements for restricted Gmail scopes. Set `APP_URL` to the public frontend URL so invite links work for recipients; localhost links only work on the same computer. `APP_ORIGIN` remains the allowed browser origin for API CORS.

New-user invitations use a random, single-use, 30-day token stored as a hash in Firestore. The token is redeemed after the invited person signs in or signs up with the invited email. Firebase Authentication is used to determine whether an account exists. For existing accounts, the event membership is added after Gmail accepts the invitation email.

## Recording

Recordings use LiveKit Cloud Egress and are written to the configured AWS S3 bucket under `gather/<event-id>/`. The bucket must be reachable by LiveKit Egress. Completed recording files appear in the gathering details, where signed playback URLs are issued to event members and expire after 15 minutes. The API server's AWS credentials need `s3:GetObject` on `gather/*` in addition to the write permissions used by Egress. Recording controls are available to moderators only; verify any required participant consent and retention policies for your deployment.
