from datetime import datetime
from uuid import uuid4

from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash


# Ces dix modèles décrivent le schéma actuel sans ouvrir eux-mêmes de base.
# Les id sont des clés primaires ; ForeignKey crée une contrainte SQL, alors
# que relationship facilite la navigation entre objets Python.
# Les default/onupdate de dates sont appliqués par SQLAlchemy, pas par un
# déclencheur SQL permanent.
db = SQLAlchemy()


# Un compte peut porter plusieurs contributions. Pseudo et email sont uniques
# indépendamment ; is_admin et is_banned sont décidés côté serveur.
class User(db.Model):
    """User and administrator account."""

    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(100), unique=True, nullable=False)
    email = db.Column(db.String(150), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    is_banned = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    stories = db.relationship("Story", back_populates="author")
    comments = db.relationship("Comment", back_populates="user")
    votes = db.relationship("Vote", back_populates="user")
    comment_likes = db.relationship(
        'CommentLike', back_populates='user', cascade='all, delete-orphan',
        passive_deletes=True
    )
    proposals = db.relationship("Proposal", back_populates="user")
    theories = db.relationship("Theory", back_populates="author")

    # Werkzeug génère un hachage salé adapté aux mots de passe. On conserve
    # ce hachage pour vérifier une saisie ultérieure, jamais le mot de passe brut.
    def set_password(self, password):
        """Hash the password before storing it."""
        self.password_hash = generate_password_hash(password)

    # Comparer par la fonction Werkzeug, sans tenter de déchiffrer le hachage.
    def check_password(self, password):
        """Check a password against its hash."""
        return check_password_hash(self.password_hash, password)

    # La représentation publique du compte exclut expressément password_hash.
    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "email": self.email,
            "is_admin": self.is_admin,
            "created_at": (
                self.created_at.isoformat()
                if self.created_at else None
            )
        }


# Une catégorie regroupe des dossiers ; son nom est unique, son id est la
# référence conservée dans stories.category_id.
class Category(db.Model):
    """Story category."""

    __tablename__ = "categories"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), unique=True, nullable=False)
    description = db.Column(db.Text)

    stories = db.relationship("Story", back_populates="category")


# Le dossier a un auteur et une catégorie obligatoires, sans ON DELETE explicite.
# Le slug unique sert aux liens lisibles ; les images restent des références de
# fichiers/URL, pas des fichiers binaires stockés dans cette table.
class Story(db.Model):
    """Criminal story."""

    __tablename__ = "stories"

    id = db.Column(db.Integer, primary_key=True)

    # NULL signifie actif. La date UTC suffit à dater le retrait sans dupliquer
    # cet état dans un booléen ; restaurer ne touche à aucune collection liée.
    archived_at = db.Column(db.DateTime, nullable=True)

    # Une nouvelle valeur à chaque création/transition invalide aussi un ancien
    # aperçu après restauration/réarchivage ou réutilisation d'un id numérique.
    # Le défaut SQL sentinelle permet l'ajout portable aux anciennes tables ;
    # la purge le refuse. Les créations ORM reçoivent toujours une vraie révision.
    management_revision = db.Column(
        db.String(32), nullable=False, unique=True,
        default=lambda: uuid4().hex, server_default='00000000000000000000000000000000'
    )

    slug = db.Column(
        db.String(150),
        unique=True,
        nullable=False
    )

    title = db.Column(
        db.String(200),
        nullable=False
    )

    summary = db.Column(
        db.Text,
        nullable=False
    )

    content = db.Column(
        db.Text,
        nullable=False
    )

    image_url = db.Column(
        db.String(500)
    )

    category_id = db.Column(
        db.Integer,
        db.ForeignKey("categories.id"),
        nullable=False
    )

    author_id = db.Column(
        db.Integer,
        db.ForeignKey("users.id"),
        nullable=False
    )

    created_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        nullable=False
    )

    updated_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False
    )

    category = db.relationship(
        "Category",
        back_populates="stories"
    )

    author = db.relationship(
        "User",
        back_populates="stories"
    )

    # Ces collections du dossier utilisent all, delete-orphan côté ORM : leur
    # gestion peut supprimer un enfant retiré de la collection. Les règles SQL
    # ON DELETE sont distinctes et exigent des contraintes effectivement actives.
    comments = db.relationship(
        "Comment",
        back_populates="story",
        cascade="all, delete-orphan"
    )

    votes = db.relationship(
        "Vote",
        back_populates="story",
        cascade="all, delete-orphan"
    )

    theories = db.relationship(
        "Theory",
        back_populates="story",
        cascade="all, delete-orphan"
    )

    cold_case_updates = db.relationship(
        "ColdCaseUpdate",
        back_populates="story",
        cascade="all, delete-orphan"
    )

    # Sérialiser les colonnes du dossier sans parcourir ses collections liées :
    # les contributions sont lues par leurs routes dédiées, pas imbriquées ici.
    def to_dict(self):
        return {
            "id": self.id,
            "slug": self.slug,
            "title": self.title,
            "summary": self.summary,
            "content": self.content,
            "image_url": self.image_url,
            "category_id": self.category_id,
            "author_id": self.author_id,
            "created_at": (
                self.created_at.isoformat()
                if self.created_at else None
            ),
            "updated_at": (
                self.updated_at.isoformat()
                if self.updated_at else None
            )
        }


# Chaque théorie dépend d'un dossier (CASCADE). Son auteur peut devenir NULL
# selon la contrainte SQL SET NULL, sans effacer le texte de la contribution.
class Theory(db.Model):
    """Theory submitted for a story."""

    __tablename__ = "theories"

    id = db.Column(
        db.Integer,
        primary_key=True
    )

    story_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "stories.id",
            name="fk_theories_story",
            ondelete="CASCADE"
        ),
        nullable=False
    )

    user_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "users.id",
            name="fk_theories_user",
            ondelete="SET NULL"
        ),
        nullable=True
    )

    title = db.Column(
        db.String(200),
        nullable=False
    )

    content = db.Column(
        db.Text,
        nullable=False
    )

    likes = db.Column(
        db.Integer,
        default=0,
        nullable=False
    )

    created_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        nullable=False
    )

    story = db.relationship(
        "Story",
        back_populates="theories"
    )

    author = db.relationship(
        "User",
        back_populates="theories"
    )


# Même principe pour les commentaires : dossier obligatoire, auteur nullable.
# Le pseudo copié dans username demeure même si user_id devient NULL : ce
# comportement ne constitue pas à lui seul une anonymisation des données.
class Comment(db.Model):
    """Comment posted on a story."""

    __tablename__ = "comments"

    id = db.Column(
        db.Integer,
        primary_key=True
    )

    story_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "stories.id",
            name="fk_comments_story",
            ondelete="CASCADE"
        ),
        nullable=False
    )

    user_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "users.id",
            name="fk_comments_user",
            ondelete="SET NULL"
        ),
        nullable=True
    )

    username = db.Column(
        db.String(100),
        default="Anonyme"
    )

    text = db.Column(
        db.Text,
        nullable=False
    )

    likes = db.Column(
        db.Integer,
        default=0,
        nullable=False
    )


    created_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        nullable=False
    )

    story = db.relationship(
        "Story",
        back_populates="comments"
    )

    user = db.relationship(
        "User",
        back_populates="comments"
    )

    # Nom distinct de l'ancien compteur reports : les lignes sont désormais
    # reliées au commentaire ; la FK protège aussi une suppression SQL directe.
    moderation_reports = db.relationship(
        'Report', back_populates='comment', cascade='all, delete-orphan',
        passive_deletes=True
    )
    # Les nouveaux likes identifient chacun leur auteur. La colonne likes
    # ci-dessus reste l'historique : elle n'est ni convertie ni remise à zéro.
    comment_likes = db.relationship(
        'CommentLike', back_populates='comment', cascade='all, delete-orphan',
        passive_deletes=True
    )

    # Le pseudo copié est conservé dans le JSON même si user_id vaut NULL.
    # Les signalements sont comptés séparément par la couche API.
    def to_dict(self):
        return {
            "id": self.id,
            "story_id": self.story_id,
            "user_id": self.user_id,
            "username": self.username,
            "text": self.text,
            "likes": self.likes,
            "created_at": (
                self.created_at.isoformat()
                if self.created_at else None
            )
        }


# Les deux références sont obligatoires et portent CASCADE. La contrainte
# composite ci-dessous interdit deux votes du même compte pour un même dossier.
class Vote(db.Model):
    """Vote submitted by a user for a story."""

    __tablename__ = "votes"

    id = db.Column(
        db.Integer,
        primary_key=True
    )

    story_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "stories.id",
            name="fk_votes_story",
            ondelete="CASCADE"
        ),
        nullable=False
    )

    user_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "users.id",
            name="fk_votes_user",
            ondelete="CASCADE"
        ),
        nullable=False
    )

    created_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        nullable=False
    )

    story = db.relationship(
        "Story",
        back_populates="votes"
    )

    user = db.relationship(
        "User",
        back_populates="votes"
    )

    # L'unicité porte sur le couple, pas sur chacune des deux colonnes isolée.
    # Elle complète le précontrôle API et protège aussi des insertions concurrentes.
    __table_args__ = (
        db.UniqueConstraint(
            "user_id",
            "story_id",
            name="unique_user_story_vote"
        ),
    )


class CommentLike(db.Model):
    """Un like individuel, distinct de l'ancien compteur de clics."""

    __tablename__ = 'comment_likes'
    id = db.Column(db.Integer, primary_key=True)
    comment_id = db.Column(
        db.Integer, db.ForeignKey('comments.id', name='fk_comment_likes_comment', ondelete='CASCADE'),
        nullable=False, index=True
    )
    user_id = db.Column(
        db.Integer, db.ForeignKey('users.id', name='fk_comment_likes_user', ondelete='CASCADE'),
        nullable=False
    )
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    comment = db.relationship('Comment', back_populates='comment_likes')
    user = db.relationship('User', back_populates='comment_likes')
    __table_args__ = (db.UniqueConstraint('user_id', 'comment_id', name='unique_user_comment_like'),)


# Une proposition reste distincte des dossiers publiés et commence en pending.
# Son auteur est obligatoire ; aucune conversion automatique en Story n'existe.
class Proposal(db.Model):
    """Story proposal submitted by a user."""

    __tablename__ = "proposals"

    id = db.Column(
        db.Integer,
        primary_key=True
    )

    user_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "users.id",
            name="fk_proposals_user",
            ondelete="CASCADE"
        ),
        nullable=False
    )

    title = db.Column(
        db.String(200),
        nullable=False
    )

    content = db.Column(
        db.Text,
        nullable=False
    )

    status = db.Column(
        db.String(20),
        default="pending",
        nullable=False
    )

    created_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        nullable=False
    )

    updated_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False
    )

    user = db.relationship(
        "User",
        back_populates="proposals"
    )


# Un signalement ne vise que Comment. type/target_id restent des propriétés
# compatibles en Python/JSON, jamais une seconde référence stockée en parallèle.
class Report(db.Model):
    """Report submitted for moderation."""

    __tablename__ = "reports"

    id = db.Column(
        db.Integer,
        primary_key=True
    )

    comment_id = db.Column(
        db.Integer,
        db.ForeignKey('comments.id', name='fk_reports_comment', ondelete='CASCADE'),
        nullable=False, index=True
    )
    comment = db.relationship('Comment', back_populates='moderation_reports')

    @property
    def type(self):
        return 'comment'

    @type.setter
    def type(self, value):
        if value != 'comment':
            raise ValueError('Seuls les signalements de commentaires sont autorisés.')

    @property
    def target_id(self):
        return str(self.comment_id)

    @target_id.setter
    def target_id(self, value):
        # Compatibilité des anciennes préparations Python : aucune normalisation
        # ambiguë, aucune conversion de type autre que la chaîne canonique.
        if (not isinstance(value, str) or not value.isascii() or
                not value.isdecimal() or value.startswith('0') or len(value) > 10 or
                not 1 <= int(value) <= 2147483647):
            raise ValueError('Identifiant de commentaire canonique requis.')
        self.comment_id = int(value)

    reason = db.Column(
        db.Text,
        nullable=False
    )

    status = db.Column(
        db.String(20),
        default="pending",
        nullable=False
    )

    created_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        nullable=False
    )

    # Garder le contrat HTTP historique sans conserver de cible textuelle en SQL.
    def to_dict(self):
        return {
            "id": self.id,
            "type": self.type,
            "target_id": self.target_id,
            "reason": self.reason,
            "status": self.status,
            "created_at": (
                self.created_at.isoformat()
                if self.created_at else None
            )
        }


# Une mise à jour référence un dossier et suit sa suppression par CASCADE.
# La clé étrangère ne garantit pas que sa catégorie soit réellement Cold Case.
class ColdCaseUpdate(db.Model):
    """Update attached to a cold case story."""

    __tablename__ = "cold_case_updates"

    id = db.Column(
        db.Integer,
        primary_key=True
    )

    story_id = db.Column(
        db.Integer,
        db.ForeignKey(
            "stories.id",
            name="fk_cold_case_updates_story",
            ondelete="CASCADE"
        ),
        nullable=False
    )

    content = db.Column(
        db.Text,
        nullable=False
    )

    created_at = db.Column(
        db.DateTime,
        default=datetime.utcnow,
        nullable=False
    )

    story = db.relationship(
        "Story",
        back_populates="cold_case_updates"
    )

    # Fournir les champs de lecture et une date ISO, sans modifier le dossier
    # ni vérifier sa catégorie : ce sont des responsabilités distinctes.
    def to_dict(self):
        return {
            "id": self.id,
            "story_id": self.story_id,
            "content": self.content,
            "created_at": (
                self.created_at.isoformat()
                if self.created_at else None
            )
        }
