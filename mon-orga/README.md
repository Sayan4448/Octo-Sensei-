# Mon Orga 📋

Petite app Android d'organisation, en Kotlin, avec Material Design 3 (thème clair et sombre automatique). Trois onglets en bas de l'écran :

- **✅ Tâches** : tape un truc à faire (« ranger le linge ») puis « + ». Touche une tâche pour la cocher : elle descend en bas de la liste. Reste appuyé pour la modifier, la supprimer ou la **programmer** : « 📅 Programmer un rappel » → jour → heure. La tâche affiche sa date (en rouge si c'est dépassé) et le téléphone sonne à l'heure dite. « Effacer les terminées » vide d'un coup les tâches cochées.
- **📝 Notes** : « Nouvelle note » pour écrire (plusieurs lignes possibles). Touche pour ouvrir/modifier, reste appuyé pour supprimer. Le bouton retour enregistre, seul « Annuler » jette le texte.
- **📅 Agenda** : touche un jour du calendrier, puis « Ajouter » → nom → heure (ou « Journée »). Les tâches programmées ce jour-là s'y affichent aussi (avec un ☐). Touche un élément pour le modifier ou le supprimer. Sous le calendrier, une ligne indique les jours du mois qui ont quelque chose de prévu, et « À venir » montre les 3 prochains événements.

Tout est sauvegardé sur le téléphone, même après fermeture de l'app. Les tâches des versions précédentes sont conservées.

## Installer sur ton téléphone

1. Récupère `MesTaches.apk` (Claude l'envoie dans la conversation à chaque version ; il n'est pas dans git) sur ton téléphone Android (8.0 ou plus).
2. Ouvre-le et autorise « Installer des applis inconnues » quand Android le demande.
3. Au premier rappel programmé, l'app demande l'autorisation d'envoyer des notifications : accepte, sinon elle ne sonnera pas.

Pour mettre à jour, installe la nouvelle version **par-dessus** l'ancienne. Ne la désinstalle jamais avant : ça effacerait tes tâches, notes et événements.

## Compiler toi-même

Ouvre ce dossier dans Android Studio, ou en ligne de commande (JDK 21, celui fourni avec Android Studio) :

```sh
./gradlew testDebugUnitTest assembleDebug
# APK : build/outputs/apk/debug/MesTaches-debug.apk
# Captures d'écran des tests (clair et sombre) : build/screenshots/
```

L'APK est signé avec `debug.keystore` (dans ce dossier) : c'est ce qui permet d'installer chaque nouvelle version par-dessus la précédente.
