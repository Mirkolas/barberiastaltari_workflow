# Workflow runner

Questo repository pubblico contiene soltanto i runner GitHub Actions. Il codice applicativo e i dati privati non vengono pubblicati.

## Secrets richiesti

Configura in **Settings → Secrets and variables → Actions**:

- `PRIVATE_REPO`: repository sorgente privato nel formato `owner/repository`.
- `PRIVATE_REPO_PAT`: Personal Access Token con sola autorizzazione necessaria a leggere il repository privato; per il backup deve anche poter effettuare push sul repository sorgente.
- `APP_DIR`: opzionale, sottocartella dell'applicazione nel repository privato; lascia vuoto se l'app è nella root.
- `FIREBASE_PROJECT_ID`: identificativo del progetto Firebase.
- `FIREBASE_SERVICE_ACCOUNT`: JSON dell'account di servizio usato dai job Firebase.

I workflow non contengono valori sensibili in chiaro. Prima di disattivare i workflow nel repository privato, esegui manualmente deploy, backup e restore in modalità sicura per verificare la configurazione.
