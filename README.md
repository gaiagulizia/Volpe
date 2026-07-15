# Atlante — Diario di viaggio

App web statica (HTML + CSS + JS puro, nessuna installazione richiesta) per programmare i tuoi viaggi: database di luoghi, tag, cestino con ripristino, ricerca, filtri e ordinamento per vicinanza.

## Come pubblicarla su GitHub Pages

1. Crea un nuovo repository su GitHub (es. `atlante-viaggi`).
2. Carica questi 3 file nella root del repository: `index.html`, `style.css`, `script.js` (e questo `README.md` se vuoi).
3. Vai su **Settings → Pages**, in "Source" seleziona il branch `main` e la cartella `/root`, poi salva.
4. Dopo qualche minuto l'app sarà online all'indirizzo `https://<tuo-utente>.github.io/<nome-repo>/`.

In alternativa, puoi semplicemente aprire `index.html` con doppio click sul tuo computer: funziona anche offline (tranne la ricerca per vicinanza, che richiede internet per geolocalizzare gli indirizzi).

## Dove sono salvati i dati

Tutto è salvato nel `localStorage` del browser che usi, quindi:
- i dati **restano solo su quel dispositivo/browser** finché non colleghi Google Drive (vedi sezione dedicata più sotto);
- se cancelli la cache/i dati di navigazione del sito senza aver mai collegato Drive, perdi i dati;
- collegando Google Drive (facoltativo), i dati vengono sincronizzati automaticamente e li ritrovi accedendo con lo stesso account da qualsiasi dispositivo.

## Funzioni incluse

- **Luoghi**: nome, indirizzo/coordinate e nazione obbligatori; città, descrizione, foto di copertina (URL o upload), orari, prezzo e stato (visitato / da visitare) facoltativi.
- **Google Maps**: ogni scheda luogo ha un link diretto alla posizione (usa le coordinate se le hai inserite come "lat, lng", altrimenti l'indirizzo testuale).
- **Tag**: fino a 10 per luogo, creabili/modificabili/eliminabili da "Gestisci tag".
- **Cestino**: gli elementi eliminati restano recuperabili per 60 giorni, poi vengono rimossi automaticamente; puoi ripristinare/eliminare singoli elementi oppure selezionarne più di uno contemporaneamente (checkbox + "Ripristina selezionati" / "Elimina selezionati"), o svuotarlo del tutto.
- **Selezione multipla**: il pulsante "Seleziona" nella schermata Luoghi permette di scegliere più luoghi insieme e, dalla barra che compare, aggiungere/rimuovere tag in blocco oppure spostarli tutti nel cestino in un colpo solo.
- **Testo multi-riga**: gli a-capo scritti nelle descrizioni dei luoghi e nelle note delle visite vengono mantenuti e mostrati esattamente come li hai scritti.
- **Ricerca**: su nome, descrizione, città, nazione e tag.
- **Ordinamento**: alfabetico, data di aggiunta (più recenti/meno recenti), vicinanza a un indirizzo o luogo scritto a mano (geocodifica tramite OpenStreetMap Nominatim, gratuita).
- **Filtri**: per nazione, per città e per uno o più tag contemporaneamente.
- **Itinerario** (seconda schermata, tab "🗓️ Itinerario"): crea giornate di viaggio, ognuna con la propria linea del tempo verticale. Per ogni giornata puoi aggiungere visite scegliendo un luogo dal database, un orario (00:00–23:59) e note facoltative; fra una visita e la successiva puoi aggiungere un collegamento "Viaggio" con titolo obbligatorio e descrizione facoltativa (es. il mezzo di trasporto usato). Le visite si riordinano automaticamente per orario.

## Sincronizzazione con Google Drive

L'app ora può accedere con Google e salvare i tuoi luoghi in un file privato e nascosto nel tuo Google Drive (nella cartella "App Data", invisibile nel Drive normale — l'app non vede né tocca nessun altro tuo file). Prima di funzionare, però, va collegata a un tuo progetto Google Cloud gratuito. Serve farlo una volta sola.

### 1. Crea le credenziali su Google Cloud (10 minuti, gratis)

1. Vai su [console.cloud.google.com](https://console.cloud.google.com/) e crea un nuovo progetto (es. "Atlante Viaggi").
2. Nel menu, vai su **API e servizi → Libreria**, cerca "Google Drive API" e clicca **Abilita**.
3. Vai su **API e servizi → Schermata consenso OAuth**:
   - Tipo utente: **Esterno**.
   - Compila nome app, la tua email e basta.
   - Nella sezione **Utenti di test**, aggiungi il tuo indirizzo Gmail (quello con cui userai l'app). Finché l'app resta in modalità "Testing" (va bene per uso personale) potrà autenticarsi solo chi è nella lista utenti di test.
4. Vai su **API e servizi → Credenziali → Crea credenziali → ID client OAuth**:
   - Tipo applicazione: **Applicazione web**.
   - In **Origini JavaScript autorizzate**, aggiungi **solo** schema + dominio, senza percorso e senza slash finale: `https://<tuo-utente>.github.io`.
     ⚠️ Attenzione se il tuo sito è un *project site* di GitHub Pages (indirizzo tipo `https://<tuo-utente>.github.io/<nome-repo>/`): l'origine da autorizzare resta comunque `https://<tuo-utente>.github.io`, **senza** `/<nome-repo>`. Google rifiuta qualunque origine con un percorso o uno slash finale — l'origine autorizzata copre comunque tutte le pagine su quel dominio, indipendentemente dal percorso.
     Se vuoi testarla anche in locale, aggiungi anche `http://localhost:5500` o simili a seconda di come la apri.
   - Salva: otterrai un **Client ID** del tipo `123456789-abcdefg.apps.googleusercontent.com`.

### 2. Incolla il Client ID nel codice

Apri `script.js` e trova questa riga vicino all'inizio del file:

```js
const GOOGLE_CLIENT_ID = "INSERISCI_QUI_IL_TUO_CLIENT_ID.apps.googleusercontent.com";
```

Sostituisci il valore con il tuo Client ID reale, salva e ricarica la pagina (o ripubblica su GitHub Pages).

### 3. Usarla

- Clicca **"Accedi con Google"** in alto: la prima volta Google mostrerà un avviso "app non verificata" (normale, perché l'app è tua e non ancora sottoposta alla revisione di Google) — clicca su **Avanzate → Vai su [nome app] (non sicuro)** per procedere, poi autorizza l'accesso.
- Se è la prima volta che colleghi Drive e hai già dei luoghi salvati localmente, l'app te lo chiede: puoi scegliere se usare i dati già presenti sul cloud o caricare quelli locali.
- Da quel momento, ogni modifica (nuovo luogo, modifica, eliminazione, tag) viene salvata automaticamente anche su Drive dopo un paio di secondi. Il pallino accanto al tuo stato di accesso diventa giallo mentre sincronizza e torna verde a sincronizzazione completata.
- Aprendo l'app da un altro dispositivo e accedendo con lo stesso account Google, ritroverai gli stessi dati.
- Puoi disconnetterti in qualsiasi momento con **"Disconnetti"**: i dati restano comunque salvati sul dispositivo che stavi usando, in locale.

### Limiti da conoscere

- Funziona solo con un account Google (non è una registrazione "email e password" vera e propria).
- Finché l'app resta in modalità "Testing" su Google Cloud, solo gli account che aggiungi come "utenti di test" possono accedere — perfetto per uso personale o con pochi familiari/amici. Se in futuro vuoi renderla pubblica per chiunque, Google richiede una verifica dell'app.
- Non c'è merge intelligente di modifiche fatte offline su due dispositivi diversi in parallelo: vince l'ultimo salvataggio inviato al cloud. Per un uso personale su pochi dispositivi non è un problema pratico, ma è bene saperlo.



## Note tecniche

- Il geocoding (per indirizzo/vicinanza) usa l'API pubblica e gratuita di [Nominatim/OpenStreetMap](https://nominatim.org/), quindi richiede una connessione internet attiva; è pensato per un uso personale/moderato.
- Le coordinate si inseriscono nel campo "Indirizzo o coordinate" nel formato `lat, lng` (es. `45.4642, 9.1900`); altrimenti puoi scrivere un indirizzo normale.
- Le foto caricate da file vengono salvate come immagine incorporata (base64) dentro al browser: per molte foto ad alta risoluzione è meglio preferire l'opzione URL, perché lo spazio di `localStorage` è limitato (circa 5-10 MB totali).
