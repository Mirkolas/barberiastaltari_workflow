# Workflow runner

Questo repository pubblico contiene soltanto i runner GitHub Actions. Il codice e i dati del repository sorgente restano privati e vengono scaricati soltanto sul runner temporaneo.

## Configurazione

La configurazione applicativa usa lo **stesso Secret del repository privato**:

- `FIREBASE_SERVICE_ACCOUNT`

Non servono `APP_DIR`, `FIREBASE_PROJECT_ID` o `RUNNER_ENABLED`: erano valori aggiunti durante la prima migrazione e non fanno parte della configurazione originale del repository privato.

Gli unici valori tecnici aggiuntivi necessari al runner pubblico sono:

- Secret `PRIVATE_REPO`: repository sorgente privato nel formato `owner/repository`.
- Secret PAT: preferibilmente `PRIVATE_REPO_PAT`. Per compatibilita i workflow riconoscono anche `PERSONAL_ACCESS_TOKEN`, `PAT`, `GH_PAT` o `GITHUB_PAT`. Deve poter leggere il repository privato; il backup deve anche poter eseguire push nel repository privato.

## Workflow

- `Deploy Firebase`: scarica il sorgente privato, esegue gli stessi test e usa `secrets.FIREBASE_SERVICE_ACCOUNT`, come il workflow privato.
- `Backup Firebase`: usa `secrets.FIREBASE_SERVICE_ACCOUNT` e salva il backup nel repository privato.
- `Ripristino Firebase`: usa `secrets.FIREBASE_SERVICE_ACCOUNT` e legge il backup dal repository privato.
- `Private source watcher`: ogni 15 minuti controlla la versione del sorgente e conserva nel pubblico soltanto un'impronta SHA-256; quando cambia avvia il deploy pubblico.
- `Configuration test`: verifica il checkout privato, il JSON del service account e `npm test`, senza eseguire deploy.

I workflow pubblici non richiedono copie rinominate delle credenziali originali.
