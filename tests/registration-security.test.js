const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!moduleMatch) throw new Error('Registration module script not found in public/index.html');

const moduleSource = moduleMatch[1].replace(/^\s*import\s+[^;]+;\s*$/gm, '');

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${name}`);
    } else {
        failed++;
        console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

async function runScenario({ registrationOk }) {
    const dom = new JSDOM(html, {
        url: 'https://example.test/',
        runScripts: 'outside-only'
    });
    const { window } = dom;
    const calls = [];
    let deleted = false;
    const user = {
        uid: 'firebase-user-1',
        getIdToken: async () => 'verified-firebase-token'
    };

    Object.assign(window, {
        initializeApp: () => ({}),
        getAuth: () => ({}),
        getFirestore: () => ({}),
        createUserWithEmailAndPassword: async () => ({ user }),
        updateProfile: async () => {},
        deleteUser: async candidate => {
            if (candidate === user) deleted = true;
        },
        signInWithEmailAndPassword: async () => ({ user }),
        sendPasswordResetEmail: async () => {},
        doc: () => ({}),
        getDoc: async () => ({ exists: () => false }),
        fetch: async (url, options = {}) => {
            calls.push({ url, options });
            if (url === '/api/auth/register-company') {
                return {
                    ok: registrationOk,
                    json: async () => registrationOk
                        ? { success: true, companyName: 'secure company' }
                        : { error: 'Company already registered' }
                };
            }
            if (url === '/api/auth/session') {
                return { ok: true, json: async () => ({ token: 'signed-session' }) };
            }
            throw new Error(`Unexpected fetch: ${url}`);
        }
    });
    window.alert = () => {};
    window.console.log = () => {};
    window.console.warn = () => {};
    window.console.error = () => {};

    window.eval(moduleSource);
    window.document.getElementById('register-firstname').value = 'Ada';
    window.document.getElementById('register-lastname').value = 'Lovelace';
    window.document.getElementById('register-company').value = 'Secure Company';
    window.document.getElementById('register-email').value = 'ada@example.test';
    window.document.getElementById('register-password').value = 'correct-horse';
    window.document.getElementById('register-confirm-password').value = 'correct-horse';
    window.document.getElementById('form-register').dispatchEvent(
        new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await new Promise(resolve => setTimeout(resolve, 250));

    dom.window.close();
    return { calls, deleted };
}

(async () => {
    console.log('Registration security browser checks\n');

    const success = await runScenario({ registrationOk: true });
    const provision = success.calls.find(call => call.url === '/api/auth/register-company');
    check('Loaded registration page calls trusted company provisioning endpoint', !!provision);
    check('Provisioning request carries the Firebase ID token',
        provision?.options?.headers?.Authorization === 'Bearer verified-firebase-token');
    check('Provisioning request sends the entered company',
        JSON.parse(provision?.options?.body || '{}').company === 'Secure Company');
    check('Successful provisioning obtains a usable signed session',
        success.calls.some(call => call.url === '/api/auth/session'));

    const failure = await runScenario({ registrationOk: false });
    check('Failed provisioning deletes the new Firebase Auth user', failure.deleted);
    check('Failed provisioning does not request a signed session',
        !failure.calls.some(call => call.url === '/api/auth/session'));
    check('Live registration module has no direct Firestore profile write',
        !/\bsetDoc\s*\(/.test(moduleSource));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed ? 1 : 0;
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});