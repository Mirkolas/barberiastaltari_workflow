# Workflow runner

Questo repository pubblico contiene soltanto i runner GitHub Actions. Il codice applicativo e i dati del repository sorgente restano privati e vengono scaricati solo sul runner temporaneo.

## Rilevamento modifiche del sorgente

`Private source watcher` viene eseguito ogni 15 minuti quando `RUNNER_ENABLED=true`. Usa il PAT per leggere soltanto il commit corrente di `main`, calcola una seconda impronta SHA-256 e conserva nella cache solo quell'impronta. Il nome del repository privato e lo SHA originale non vengono salvati nei file pubblici.

Quando rileva una nuova versione avvia `Deploy Firebase` nel repository pubblico. Il watcher puo essere eseguito manualmente con `force=true` per forzare il deploy.

## Secrets richiesti

Configura in **Settings → Secrets and variables → Actions**:

- `PRIVATE_REPO`: repository sorgente privato nel formato `owner/repository`.
- `PRIVATE_REPO_PAT`: PAT con accesso al repository privato. Per il backup deve avere anche il permesso di scrivere nel repository sorgente, perche il backup viene committato li e non nel repository pubblico.
- `RUNNER_ENABLED`: imposta esattamente `true` soltanto dopo i test manuali; abilita watcher e backup schedulato.
- `APP_DIR`: opzionale, sottocartella dell'applicazione nel repository privato; lascia vuoto se l'app e nella root.
- `FIREBASE_PROJECT_ID`: identificativo del progetto Firebase.
- `FIREBASE_SERVICE_ACCOUNT`: JSON dell'account di servizio usato dai job Firebase.

## Cutover sicuro

1. Copia i secret qui e lascia `RUNNER_ENABLED` diverso da `true`.
2. Avvia manualmente `Deploy Firebase` e `Backup Firebase`. I test manuali funzionano anche con i cron disabilitati.
3. Per `Ripristino Firebase`, usa inizialmente soltanto una copia/backup di test e la conferma richiesta dal workflow.
4. Quando deploy e backup pubblici sono riusciti, imposta `RUNNER_ENABLED=true`.
5. Verifica almeno un ciclo del watcher e del backup pubblico; poi disattiva i vecchi trigger automatici nel repository privato per evitare doppie esecuzioni.

Nessun valore sensibile e hardcoded nei workflow pubblici; i workflow privati restano invariati come fallback finche non completi manualmente il passaggio delle credenziali.
