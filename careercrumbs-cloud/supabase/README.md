# Setting up CareerCrumbs accounts (Supabase)

Accounts are optional. Without this setup, CareerCrumbs works exactly as before and the sign-in option doesn't appear. With it, people can sign in with an emailed 6-digit code and sync their data between devices.

You'll need about 20 minutes and a free Supabase account.

## 1. Create the project
1. Go to https://supabase.com, sign up, and create a **New project**. Pick a region near your users and save the database password somewhere safe.
2. When it's ready, open **Project Settings → API** and copy:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon public** key (a long string starting with `eyJ`). This key is safe to put in the app; the database rules below are what protect people's data. Never use the `service_role` key in the app.

## 2. Create the table and rules
Open **SQL Editor → New query**, paste everything from `schema.sql`, and click **Run**. It creates the `workspaces` table, turns on row-level security so each person can only reach their own row, and adds the `delete_my_account` function the app's "Delete my account" button uses.

## 3. Turn on email codes
1. **Authentication → Sign In / Providers → Email**: make sure Email is enabled. Leave "Confirm email" on.
2. **Authentication → Emails → Templates**: in both **Magic Link** and **Confirm signup**, replace the body so it shows the code, for example:
   ```html
   <h2>Your CareerCrumbs code</h2>
   <p>Enter this code in CareerCrumbs: <strong>{{ .Token }}</strong></p>
   <p>It expires in an hour. If you didn't ask for it, you can ignore this email.</p>
   ```
3. **Authentication → Emails → SMTP settings**: before launch, connect your own email sender (for example Resend, Postmark or Amazon SES). Supabase's built-in sender only allows a few emails an hour and is meant for testing.
4. **Authentication → Rate Limits**: the defaults are fine to start.

## 4. Put the keys into the build
The keys go into the app at build time.

- **GitHub (test APKs):** in the repository, open **Settings → Secrets and variables → Actions → Variables** and add `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The next push builds an APK with accounts on.
- **Website:** build with them set:
  ```
  SUPABASE_URL=https://abcdefgh.supabase.co SUPABASE_ANON_KEY=eyJ... npm run build
  ```
  then host the `site/` folder.

## 5. Before launch
- Update the contact email in the privacy policy (`CONTACT_EMAIL` when building).
- In Google Play's **Data safety** form, declare that, for people who sign in, the app collects their **email address** and **app content** (jobs, answers, stories) to provide sync, that data is encrypted in transit, and that people can delete it with **Me → Delete my account**. Play also asks for a web page where people can request deletion; the privacy policy covers this.
