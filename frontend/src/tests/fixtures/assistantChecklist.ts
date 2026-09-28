/**
 * A step-by-step answer as an AI assistant writes one — the paste the owner
 * asked Púca to understand: a chatty intro, a heading, numbered steps with a
 * bulleted sub-step, **bold**, a link, a section heading and a closing
 * sentence. Shared by every paste test, so each surface is held to the SAME
 * reading of the same text.
 */
export const ASSISTANT_ANSWER = `Sure! Here's how to set up your new router:

# Router setup

1. **Unplug** the old router
2. Connect the new one to the modem
   - Use the cable in the box
3. Log in at [the admin page](http://192.168.1.1)

## Security

- Change the admin password
- Turn on **WPA3**

That's it — you're all set!`;

/** Its heading: what an untitled note or a new list is named. */
export const ASSISTANT_TITLE = 'Router setup';

/** Its steps, clean and in order (the section heading stays, so the grouping
 *  survives; the intro and the closing sentence do not). */
export const ASSISTANT_ITEMS = [
    'Unplug the old router',
    'Connect the new one to the modem',
    'Use the cable in the box',
    'Log in at the admin page (http://192.168.1.1)',
    'Security:',
    'Change the admin password',
    'Turn on WPA3',
];
