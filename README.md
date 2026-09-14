# Runner Barberia Staltari

Questo repository pubblico contiene runtime, test con dati fittizi e workflow. Sorgenti del sito, credenziali e snapshot dei clienti restano nel repository privato.

## Configurazione

- `FIREBASE_SERVICE_ACCOUNT`: JSON del service account Firebase.
- `PRIVATE_REPO`: repository sorgente privato nel formato owner/repository.
- `PRIVATE_REPO_PAT`: PAT con accesso al repository privato; i workflow accettano anche PERSONAL_ACCESS_TOKEN, PAT, GH_PAT e GITHUB_PAT.
- Node.js 22. Le dipendenze sono installate con `npm ci` e controllate con `npm audit`.

Il backup automatico usa come destinazione privata `Mirkolas/barberiastaltari-backup`.
Per trasferire il progetto al titolare aggiornare anche questa destinazione esplicita.

## Workflow

- **Backup Firebase automatico**: domenica alle 23:30 Europe/Rome. Backup completo ricorsivo di Firestore e rilettura di Authentication, inclusi hash password. Conserva quattro cartelle nel checkout; la cronologia Git mantiene le copie precedenti.
- **Backup Firebase manuale**: stessa esportazione completa, su richiesta.
- **Deploy Firebase**: manuale o richiamato dal watcher; esegue test statici, comportamento ed emulatore prima di pubblicare Hosting, regole e indici.
- **Private source watcher manuale**: considera solo il contenuto del sito, esclude i commit di backup e memorizza il digest soltanto dopo un deploy riuscito. Non è schedulato.
- **Configuration test**: verifica credenziali, checkout e test senza deploy. L'input opzionale `source_ref` consente di verificare un branch prima dell'integrazione.
- **Full workflow test launcher**: accoda soltanto Configuration test; non esegue deploy, backup o ripristini.
- **Verifica runner senza credenziali**: test del runtime su push e pull request, senza accesso ai dati di produzione.
- **Ripristino Firebase**: manuale, richiede una cartella valida e la conferma RIPRISTINA. Gli input sono passati tramite variabili d'ambiente.

Il vecchio `incremental-backup.js` resta disponibile per compatibilità, ma non viene più usato dal workflow automatico: il riuso degli snapshot poteva perdere eliminazioni e aggiornamenti di Authentication.
I file `backup-root-only.js` sono legacy e non rappresentano un backup completo.

## Test locali

```sh
npm ci
npm test
npm audit --omit=dev
```

I test usano fixture sintetiche e verificano subcollection, tipi Firestore, hash mancanti e rotazione delle copie. Non inviano email e non accedono a Firebase.
