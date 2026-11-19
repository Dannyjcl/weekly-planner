/*
 * Google Calendar on the Schedule tab: settings.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ SETUP: paste your OAuth 2.0 *Web client ID* between the quotes.      │
 * │ It looks like 123456789-abc123.apps.googleusercontent.com            │
 * │ A client ID is public (it is not a secret), so it's fine to commit.  │
 * │ Never put a client SECRET, an API key or an access token here.       │
 * │ Leave it empty and the planner works exactly as before.              │
 * └──────────────────────────────────────────────────────────────────────┘
 * Step-by-step setup is in the README ("Google Calendar on the schedule").
 */
window.GCAL_CONFIG = {
    clientId: '',

    // Which calendar to show. 'primary' is your main Google Calendar.
    calendarId: 'primary',

    // Times are always shown in this zone, whatever the device is set to.
    timeZone: 'America/Chicago',
};
