/**
 * A step-by-step answer as an AI assistant writes one — the paste the owner
 * asked Púca to understand: a chatty intro, a heading, numbered steps with a
 * bulleted sub-step, **bold**, a link, a section heading and a closing
 * sentence. Shared by every paste test, so each surface is held to the SAME
 * reading of the same text.
 */
import { headingLabel } from '../../api/taskHeading';

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

/** Its steps, clean and in order, AS STORED: the section heading stays, as
 *  a heading item (api/taskHeading.ts), so the grouping survives without
 *  one more box to tick; the intro and the closing sentence do not. */
export const ASSISTANT_ITEMS = [
    'Unplug the old router',
    'Connect the new one to the modem',
    'Use the cable in the box',
    'Log in at the admin page (http://192.168.1.1)',
    '## Security',
    'Change the admin password',
    'Turn on WPA3',
];

/** What the paste question lists (and a heading row shows): the heading by
 *  its label. */
export const ASSISTANT_SHOWN = ASSISTANT_ITEMS.map(headingLabel);

/** How many of them are steps — what a list's "0/N" counts. */
export const ASSISTANT_STEPS = 6;

/** The paste question's answer that creates them. */
export const ASSISTANT_ADD = 'Add 6 items and 1 heading';

/**
 * The SAME answer as the clipboard holds it when it was selected on the page
 * it was rendered on, not taken with a Copy button. Its plain text has no
 * marks left: this is what a real Chromium's selection of the rendered
 * answer gives, measured (no "#", no "1.", the heading and the section one
 * line each). Read alone it is ten plain lines, the chatty intro, the title
 * and the section included.
 */
export const ASSISTANT_RENDERED_TEXT = "Sure! Here's how to set up your new router:\n\nRouter setup\nUnplug the old router\nConnect the new one to the modem\nUse the cable in the box\nLog in at the admin page\nSecurity\nChange the admin password\nTurn on WPA3\nThat's it — you're all set!";

/** ...and the HTML beside it, the way Chromium writes a copied selection:
 *  a charset, the fragment markers, computed styles inline, and every link
 *  resolved (a bare host gains its "/"). */
export const ASSISTANT_HTML = '<meta charset=\'utf-8\'><html><body><!--StartFragment-->'
    + '<p style="margin: 0px 0px 12px; color: rgb(31, 31, 31); font-family: system-ui; font-size: 16px; white-space: normal;">Sure! Here\'s how to set up your new router:</p>'
    + '<h1 style="font-size: 24px; font-weight: 600; margin: 16px 0px 8px;">Router setup</h1>'
    + '<ol style="padding-left: 24px; white-space: normal;"><li><strong style="font-weight: 600;">Unplug</strong> the old router</li>'
    + '<li>Connect the new one to the modem<ul style="list-style-type: disc;"><li>Use the cable in the box</li></ul></li>'
    + '<li>Log in at <a href="http://192.168.1.1/" style="color: rgb(11, 87, 208); text-decoration: underline;">the admin page</a></li></ol>'
    + '<h2 style="font-size: 20px; font-weight: 600;">Security</h2>'
    + '<ul style="padding-left: 24px;"><li>Change the admin password</li><li>Turn on <strong style="font-weight: 600;">WPA3</strong></li></ul>'
    + '<p style="margin: 12px 0px 0px;">That\'s it — you\'re all set!</p>'
    + '<!--EndFragment--></body></html>';

/** What that plain text alone becomes — one item per line, the title and
 *  the section among them: the paste as it was before the HTML was read. */
export const ASSISTANT_RENDERED_LINES = ASSISTANT_RENDERED_TEXT.split('\n').filter(l => l.trim() !== '');
