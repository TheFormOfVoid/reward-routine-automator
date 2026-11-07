# Reward Routine

Runs the Reward Routine Automator extension (the Gingerbread build) once a
day, in a real Chromium window on a virtual screen inside the add-on. Open
**Rewards** in the sidebar to see the status, the recent runs and the log, to
start a run by hand, or to watch the browser screen.

## First start: sign in once

1. Start the add-on and open **Rewards** in the sidebar.
2. Press **Open browser for sign-in**. The browser screen appears below the
   status. Click into it and sign in to your Microsoft account on the
   Microsoft page that opens. Tick "stay signed in" when asked.
3. Press **Close browser**, then **Check sign-in**. It should say "Signed in".

The sign-in is kept in the add-on's data. When Microsoft signs you out (every
few weeks, or after a security check), the next run stops with "sign-in
needed" (and notifies you if you set a notification URL). Sign in again the
same way; today's run then starts as soon as you press **Close browser**.

## Changing the daily time

Set **Daily run time** on the Configuration tab and restart the add-on. The
time is in Home Assistant's timezone unless you set **Timezone**.

## Notifications

With **Notify my phone** on (the default), every run sends a notification to
the Home Assistant app on your phone: points earned, balance, which steps ran,
how long it took and when the next run is. Failures and "sign-in needed" are
sent as high-priority. Tapping the notification opens the Rewards panel. Set
**Phone notify service** to pick one phone; empty sends to every phone with
the app. Turn off **Notify on success** to hear only about problems.

## What a run does

The controller starts Chromium, checks that you are signed in, starts the
extension's full routine (stats, daily set, keep earning, image search, web
searches, claim), follows it until the extension records the run as finished,
then closes Chromium. Failed or incomplete runs are retried. Every run is
written to the log and to `/data/logs/runs.jsonl` in the add-on's data.

The controller turns off the extension's own triggers (start-up run, built-in
schedule, confirm prompt) and its all-day background searches, so the routine
runs once a day and only then.

## Notes

- The browser screen is only reachable through Home Assistant (ingress); the
  add-on publishes no ports.
- Backups include the browser profile, which holds your Microsoft sign-in.
  Protect your backups accordingly.
- Automating Microsoft Rewards is against Microsoft's Rewards terms, and
  Microsoft may suspend the Rewards account and void its points.
