# Criminal Stories Blog

**Criminal Stories Blog**, présenté dans l’interface sous le nom **Les Petits Enquêteurs**, est un blog consacré aux affaires résolues et aux Cold Cases. Chaque dossier peut recevoir des commentaires et des théories.

- **Visiteur** · Lire les dossiers, rechercher une affaire et consulter les contributions.
- **Membre** · Publier une théorie ou un commentaire, proposer une histoire et interagir avec les contenus.
- **Administrateur** · Consulter le tableau de bord et les signalements, gérer les dossiers et les comptes.

L’interface utilise HTML, CSS et JavaScript. Flask sert les pages et l’API sur la même adresse. SQLAlchemy relie l’API à une base SQLite locale.

## Démarrer sous Windows

Prérequis · Python 3.13 et Git. Les commandes suivantes s’exécutent dans PowerShell.

```powershell
git clone https://github.com/Mahamadou19-75/RNCP.git
cd RNCP
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
.\.venv\Scripts\python.exe -I -B tools/demo_persistante.py init
.\.venv\Scripts\python.exe -I -B tools/demo_persistante.py check
.\.venv\Scripts\python.exe -I -B tools/demo_persistante.py serve
```

La commande `init` crée la base SQLite et charge six dossiers. Elle demande en console les adresses et les mots de passe des comptes locaux `admin`, `Alice` et `Bob`. Pour une installation depuis une archive, exécuter `git init` à la racine du dossier décompressé avant la commande `init`.

- [Ouvrir le site](http://127.0.0.1:5066/)
- [Ouvrir l’administration](http://127.0.0.1:5066/admin-connexion.html)
- [Consulter l’API dans Swagger](http://127.0.0.1:5066/api/v1/swagger)

Les démarrages suivants utilisent `check`, puis `serve` dans le même dossier. Les comptes et contributions restent dans `instance/demo-persistante/`. Les fichiers de données et la clé de session sont exclus de Git.

## Parcours d’utilisation · Publier une théorie

1. Ouvrir un dossier depuis l’accueil ou le catalogue.
2. Se connecter avec un compte membre et accéder à **Analyse & Théories**.
3. Sélectionner le dossier concerné, renseigner un titre et un texte, puis publier la théorie.
4. Dans **Théories publiées**, sélectionner le même dossier et cliquer sur **Actualiser**. La contribution enregistrée apparaît dans la liste.

## Schémas

### 1. Enchaînement des écrans · Diagramme de navigation

Le schéma présente les accès à la lecture, à la contribution et à l’administration.

```mermaid
flowchart LR
    Accueil["Accueil"] --> Liste["Histoires ou Cold Cases"]
    Accueil -->|Dossier à la une| Fiche["Fiche du dossier"]
    Liste --> Fiche
    Fiche --> Liste
    Fiche --> Commentaires["Commentaires"]
    Menu["Menu principal"] --> Theories["Analyse et Théories"]
    Theories --> Formulaire["Formulaire de théorie"]
    Menu --> Connexion["Connexion membre"]
    Connexion <--> Inscription["Inscription"]
    Connexion --> Accueil
    Pied["Pied de page"] --> Admin["Connexion administrateur"]
    Admin --> Tableau["Tableau de bord"]
```

### 2. Modèle conceptuel · Diagramme entité-association

Chaque relation indique les cardinalités. Par exemple, un dossier appartient à une catégorie et peut recevoir plusieurs commentaires. Un commentaire ou une théorie peut conserver son lien au dossier si la référence au compte auteur est effacée.

```mermaid
erDiagram
    CATEGORIE ||--o{ DOSSIER : classe
    COMPTE ||--o{ DOSSIER : redige
    DOSSIER ||--o{ COMMENTAIRE : recoit
    COMPTE |o--o{ COMMENTAIRE : signe
    DOSSIER ||--o{ THEORIE : recoit
    COMPTE |o--o{ THEORIE : signe
    DOSSIER ||--o{ VOTE_DOSSIER : recoit
    COMPTE ||--o{ VOTE_DOSSIER : emet
    COMMENTAIRE ||--o{ LIKE_COMMENTAIRE : recoit
    COMPTE ||--o{ LIKE_COMMENTAIRE : emet
    COMPTE ||--o{ PROPOSITION : soumet
    COMMENTAIRE ||--o{ SIGNALEMENT : motive
    DOSSIER ||--o{ MISE_A_JOUR : recoit
```

### 3. Schéma physique SQLite · Tables et clés

Les dix tables ci-dessous montrent leurs clés primaires, leurs références et les champs d’unicité essentiels. Le schéma complet figure dans [les modèles SQLAlchemy](backend/models.py).

```mermaid
erDiagram
    categories ||--o{ stories : category_id
    users ||--o{ stories : author_id
    stories ||--o{ comments : story_id
    users |o--o{ comments : user_id
    stories ||--o{ theories : story_id
    users |o--o{ theories : user_id
    stories ||--o{ votes : story_id
    users ||--o{ votes : user_id
    comments ||--o{ comment_likes : comment_id
    users ||--o{ comment_likes : user_id
    users ||--o{ proposals : user_id
    comments ||--o{ reports : comment_id
    stories ||--o{ cold_case_updates : story_id

    categories {
        INTEGER id PK
        VARCHAR name UK
    }
    users {
        INTEGER id PK
        VARCHAR username UK
        VARCHAR email UK
    }
    stories {
        INTEGER id PK
        INTEGER category_id FK
        INTEGER author_id FK
        VARCHAR slug UK
        VARCHAR management_revision UK
    }
    comments {
        INTEGER id PK
        INTEGER story_id FK
        INTEGER user_id FK "nullable"
    }
    theories {
        INTEGER id PK
        INTEGER story_id FK
        INTEGER user_id FK "nullable"
    }
    votes {
        INTEGER id PK
        INTEGER user_id FK
        INTEGER story_id FK
    }
    comment_likes {
        INTEGER id PK
        INTEGER user_id FK
        INTEGER comment_id FK
    }
    proposals {
        INTEGER id PK
        INTEGER user_id FK
    }
    reports {
        INTEGER id PK
        INTEGER comment_id FK
    }
    cold_case_updates {
        INTEGER id PK
        INTEGER story_id FK
    }
```

- Les paires `(user_id, story_id)` dans `votes` et `(user_id, comment_id)` dans `comment_likes` sont uniques.
- `comments.user_id` et `theories.user_id` utilisent `SET NULL`. Les références de `stories` vers son auteur et sa catégorie gardent le comportement par défaut. Les autres références du schéma utilisent `CASCADE`.

### 4. Publication d’une théorie · Diagramme de séquence

```mermaid
sequenceDiagram
    actor Membre
    participant Navigateur
    participant Flask
    participant SQLite
    Membre->>Navigateur: Choisit un dossier et saisit une théorie
    Navigateur->>Flask: POST /api/v1/stories/{id}/theories
    Flask->>Flask: Vérifie session, jeton CSRF et saisie
    Flask->>SQLite: Vérifie le dossier actif et enregistre la théorie
    SQLite-->>Flask: Confirme la transaction
    Flask-->>Navigateur: HTTP 201 et théorie enregistrée
    Navigateur-->>Membre: Confirme la publication
```

## Vérifications

Les tests d’intégration utilisent une base SQLite en mémoire et un jeu de données d’essai. Node.js sert aux tests de l’interface.

```powershell
.\.venv\Scripts\python.exe -I -B tools/recette_lot6g4.py --check-journey
.\.venv\Scripts\python.exe -I -B tools/recette_lot6g4.py --histoires-originales --check-histoires
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p test_demo_persistante.py
node --test frontend/tests/*.test.cjs
```

Swagger documente les routes disponibles. L’inscription publique crée un compte membre.

## Pistes d’amélioration

- Étendre les essais à des appareils mobiles physiques.
- Optimiser le poids des illustrations.
- Automatiser l’exécution des tests sur GitHub.
- Documenter le parcours de modération.
