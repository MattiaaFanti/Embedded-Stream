# HTSport - Passkey e archivio licenze

Questa implementazione è proposta nel branch feature/passkey-license-console. Non fare merge nella main prima della configurazione di Cloudflare: la nuova pagina index.html bloccherebbe il sito fino all'attivazione dell'API.

## Componenti

- index.html, site.js e style.css: primo accesso tramite nome e Passkey; sessione automatica se ancora valida; schermata di attesa approvazione e successivo accesso a HTSport.
- admin.html e admin.js: approvazione utenti, ban account, revoca Passkey, licenze con seriali e note, attività amministrative.
- auth.js: API nativa WebAuthn; nessuna libreria JavaScript remota.
- cloudflare/src/index.js: Cloudflare Worker con verifica crittografica passkey, sessioni, permessi, audit e cifratura AES-256-GCM.
- cloudflare/migrations/0001_init.sql: struttura D1 persistente.
- config.js: solo URL pubblici, nessun segreto.
- Il Worker della guida Tampermonkey/Violentmonkey preesistente rimane invariato.

## Attivazione Cloudflare

Occorrono Node.js, Wrangler e un account Cloudflare autorizzato.

1. Scarica il branch e apri il terminale nella cartella cloudflare.
2. Esegui:

    npm install
    npx wrangler login
    npx wrangler d1 create htsport-license-db

3. Copia il database_id restituito dal comando in cloudflare/wrangler.jsonc, sostituendo REPLACE_WITH_REAL_D1_DATABASE_ID. Lascia DB come nome del binding.

4. Genera tre segreti casuali indipendenti con questi comandi, uno per ciascuno:

    openssl rand -hex 32
    openssl rand -hex 32
    openssl rand -base64 32

Il primo serve per BOOTSTRAP_SECRET, il secondo per TOKEN_PEPPER, il terzo per ENCRYPTION_KEY. Quest'ultimo deve decodificare esattamente 32 byte.

5. Carica i segreti direttamente su Cloudflare tramite Wrangler; non inserirli mai in GitHub:

    npx wrangler secret put BOOTSTRAP_SECRET
    npx wrangler secret put TOKEN_PEPPER
    npx wrangler secret put ENCRYPTION_KEY

6. Applica le migrazioni e distribuisci il nuovo Worker:

    npm run db:migrate
    npm run deploy

7. Copia l'URL HTTPS del nuovo Worker in config.js al posto di https://REPLACE-WITH-YOUR-LICENSE-WORKER.workers.dev. È una configurazione pubblica, non una credenziale.

8. La configurazione RP_ID e SITE_ORIGIN è già predisposta per il sito https://mattiaafanti.github.io/Embedded-Stream/. Se scegli un dominio personalizzato, imposta RP_ID sull'hostname e SITE_ORIGIN sull'origine HTTPS, prima di registrare Passkey.

9. Testa il Worker e il sito nella versione di sviluppo. Poi effettua il merge della pull request.

10. Apri https://mattiaafanti.github.io/Embedded-Stream/admin.html. Se non esiste ancora alcun amministratore, compare il modulo per il primo amministratore. Usa il BOOTSTRAP_SECRET generato, un nome e crea una Passkey.

11. Apri index.html in una nuova sessione/browser: inserisci il nome e registra la Passkey. La registrazione compare come pending nel pannello; l'amministratore la approva dalla scheda Utenti. Dopo l'approvazione, il proprietario può accedere.

12. Dalla scheda Licenze e seriali registra prodotto, seriale, note, scadenza, assegnazione e stato. Seriali e note vengono conservati cifrati in D1.

## Comportamento

- Alla prima registrazione l'utente sceglie solo il nome; la Passkey viene custodita dal gestore credenziali.
- Il backend crea un ID UUID persistente. Non è un numero hardware né un fingerprint del telefono.
- Se esiste una sessione valida in localStorage, index.html verifica immediatamente la sessione sul server e carica lo stream solo per utenti active.
- Dopo la cancellazione di cookie e storage, la sessione sparisce ma la Passkey può restare disponibile nell'account Apple/Google o nella memoria sicura del sistema. Per rientrare occorre scegliere Accedi con Passkey e confermare con biometria o PIN.
- Al primo accesso autorizzato, il sito mostra Benvenuto e reindirizza alla guida HTSport. Il segnalibro della guida è locale, non una prova di identità.
- Il ban blocca tutte le sessioni dell'account. La revoca disabilita una specifica Passkey e invalida le sessioni associate all'utente.
- Le sessioni sono token casuali con durata di sette giorni, il cui hash con pepper è conservato in D1.
- L'archivio licenze non è disponibile al frontend utente, ma solo a sessioni amministrative.

## Limiti e requisiti importanti

- Le Passkey sincronizzate possono apparire su più dispositivi. Non sono un identificatore univoco hardware. Un utente bannato può tentare una nuova registrazione con un'altra Passkey; la nuova richiesta rimarrà in attesa di approvazione.
- Il blocco in index.html protegge il percorso nella pagina GitHub Pages, ma non l'indirizzo originale https://htsport.info/ e non sostituisce una protezione server-side del contenuto video. Per impedire accessi diretti occorre proteggere l'origine dello stream.
- GitHub Pages è un host statico pubblico: non inserire token privati, seriali in chiaro né chiavi Cloudflare nei file del repository.
- Le chiavi di cifratura non devono essere perse. Senza ENCRYPTION_KEY i seriali memorizzati non sono più decifrabili.
- Rate limiting per IP incorporato; per produzione pubblica è opportuno associare Cloudflare WAF/Turnstile e monitorare gli abusi.
- Sono mostrati fino a 500 utenti, credenziali e licenze e 100 eventi di audit. La paginazione va aggiunta se l'archivio cresce molto.
- Passkey e verifica server devono essere testate realmente su iOS, Android e desktop prima della pubblicazione.

## API

GET /api/health
POST /api/register/options
POST /api/register/verify
POST /api/login/options
POST /api/login/verify
GET /api/me
POST /api/logout
GET /api/admin/bootstrap/status
POST /api/admin/bootstrap/options
POST /api/admin/bootstrap/verify
GET /api/admin/summary
GET /api/admin/users
GET /api/admin/credentials
GET /api/admin/licenses
GET /api/admin/audit
POST /api/admin/users/:id/status
POST /api/admin/credentials/:id/revoke
POST /api/admin/licenses
POST /api/admin/licenses/:id

I segreti di bootstrap sono richiesti solo per la creazione iniziale dell'amministratore. Le chiamate amministrative richiedono una sessione active con ruolo admin.
