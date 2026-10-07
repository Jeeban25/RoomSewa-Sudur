# RoomSewa-Sudur

RoomSewa-Sudur is focused exclusively on student room rentals in Mahendranagar.

## Firebase setup

1. Create a Firebase project and register a Web app. Enable Email/Password in Authentication and create a Firestore database. Keep Firebase Storage enabled if you have legacy listing photos stored there; new listing photos use ImgBB.
2. Copy the Web app values into `assets/js/firebase-config.js`. Set `adminEmail` to the email address of the administrator's Firebase Authentication account. The public admin username `jeeban` is mapped to that email; the password is never stored in this repository.
3. In Firebase Authentication, create the admin user with a strong password. Do not use `1234`: it is not a secure password. Tenant and house-owner accounts can be requested through registration, but require administrator approval before they can sign in and use the app.
   Existing tenant and house-owner accounts also require approval after the updated rules are deployed; approve them from the Admin Dashboard.
4. Install the Firebase CLI and authenticate it, then deploy Firestore rules, Storage rules, Functions, and Hosting:

   ```sh
   firebase login
   firebase use YOUR_PROJECT_ID
   cd functions
   npm install
   cd ..
   firebase deploy
   ```

   Cloud Functions may require the Firebase project to be on the Blaze plan.
   If creating a listing draft fails with a Firebase permission error after deploying only the website, deploy the current Firestore rules from this directory with `firebase deploy --only firestore:rules --project YOUR_PROJECT_ID`.
5. Assign the only admin claim using trusted Application Default Credentials from an authorized administrator environment. For local setup, authenticate with `gcloud auth application-default login`, or point `GOOGLE_APPLICATION_CREDENTIALS` at a service-account file kept outside this repository:

   ```sh
   cd functions
   node bootstrap-admin.js YOUR_ADMIN_FIREBASE_EMAIL
   ```

   The bootstrap script refuses to grant admin when another admin claim already exists. It assigns the Firebase Authentication admin claim and marks the matching Firestore profile approved. The administrator must sign out and sign back in after the claim is assigned.

   The admin account keeps its trusted admin claim while using the Admin, Owner, and Tenant dashboard views. Use the mode links on the dashboards to switch views. Approved owners land on the Owner Dashboard, approved tenants land on the Tenant Dashboard, and admins with the trusted claim land on the Admin Dashboard. Only approved, active house-owner accounts can create listings, upload listing photos, or initiate and verify listing payments; admin access does not grant permission to list a room.

House owners can create Mahendranagar listings with photos, a WhatsApp contact number, and map coordinates. Monthly rent can be any whole NPR amount from 0 to 100,000; the listing fee is 1.25% of that rent. Fees below NPR 10.01 are waived because the online gateways will not process them. For higher fees, owners pay through eSewa or Khalti. A listing becomes reviewable only after a Cloud Function verifies the transaction directly with the selected provider, or records an allowed fee waiver; browser redirects are not treated as proof of payment. Admins can approve only paid or waived listings.

### Payment provider setup

1. Create merchant accounts and obtain the eSewa product code/secret and Khalti secret. Use eSewa's UAT credentials while testing.
2. Set the secrets without putting them in source control:

   ```sh
   firebase functions:secrets:set ESEWA_SECRET_KEY
   firebase functions:secrets:set KHALTI_SECRET_KEY
   firebase functions:secrets:set IMGBB_API_KEY
   ```

   Listing-photo uploads go through the authenticated `uploadListingImage` Cloud Function. Keep the ImgBB API key in the `IMGBB_API_KEY` Functions secret; never put it in frontend JavaScript. Owners need the current Firestore create/update rules deployed before the draft can be created and photos uploaded.
   After setting the secret, deploy the callable and Firestore rules with `firebase deploy --only functions,firestore:rules --project YOUR_PROJECT_ID`.

3. Create `functions/.env.YOUR_PROJECT_ID` (this file is git-ignored) with the merchant product code, provider environment, and deployed site origin:

   ```dotenv
   ESEWA_PRODUCT_CODE="YOUR_ESEWA_PRODUCT_CODE"
   ESEWA_ENVIRONMENT="uat"
   PUBLIC_SITE_URL="https://YOUR_PROJECT_ID.web.app"
   ```

   Use `ESEWA_ENVIRONMENT="production"` only after configuring the production merchant account. `PUBLIC_SITE_URL` must be HTTPS outside local development.
4. Deploy the website, Cloud Functions, and rules:

   ```sh
   firebase deploy
   ```

   If the eSewa or Khalti credentials are not configured, payment initiation will report a setup error and the saved listing can be retried from the House Owner Dashboard.

Firestore payment records are private to the Cloud Functions. The functions calculate the fee from the saved rent, verify amounts and transaction identifiers with the providers, and only then move a listing into review.

The map uses Leaflet with OpenStreetMap tiles. Keep the OpenStreetMap attribution visible and follow the tile usage policy.

## Local preview

Serve this directory with a local static web server (ES modules do not work reliably from `file://` URLs). Configure Firebase before using registration, login, reset, listings, or admin features.
