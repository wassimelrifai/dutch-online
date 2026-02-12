const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public")); // Sert le fichier index.html

// --- CONSTANTES ET CONFIGURATION ---
const SUITS = ['♠', '♣', '♥', '♦'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// État global des jeux (clés = room ID)
let games = {};

// --- UTILITAIRES DE JEU ---

function createDeck() {
    let deck = [];
    // Cartes normales
    for (let s of SUITS) {
        for (let v of VALUES) {
            let points = 0;
            let val = parseInt(v);
            
            if (v === 'A') points = 1;
            else if (!isNaN(val)) points = val;
            else if (v === 'J' || v === 'Q') points = 13;
            else if (v === 'K') {
                points = (s === '♥' || s === '♦') ? 0 : 13; // Roi rouge = 0, Noir = 13
            }
            deck.push({ suit: s, value: v, points: points, id: Math.random().toString(36).substr(2, 9) });
        }
    }
    // Jokers (-3 points)
    deck.push({ suit: '🤡', value: 'Joker', points: -3, id: 'joker1' });
    deck.push({ suit: '🤡', value: 'Joker', points: -3, id: 'joker2' });
    
    return shuffle(deck);
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// --- LOGIQUE SOCKET.IO ---

io.on('connection', (socket) => {
    console.log('Un joueur connecté:', socket.id);

// Rejoindre une salle
    socket.on('joinGame', ({ room, playerName }) => {
        playerName = playerName.trim();
        room = room.trim();
        if (!playerName || !room) return;

        socket.join(room);
        
        if (!games[room]) {
            games[room] = {
                players: [],
                deck: [],
                discardPile: [],
                currentPlayerIndex: 0,
                state: 'LOBBY', 
                dutchCaller: null, 
                lastRound: false,
                actionState: null,
                lastPlayerId: null
            };
        }

        const game = games[room];

        // --- SÉCURITÉ ---
        // 1. Déjà connecté ?
        if (game.players.find(p => p.id === socket.id)) return;

        // 2. Pseudo pris ?
        if (game.players.find(p => p.name.toLowerCase() === playerName.toLowerCase())) {
            socket.emit('error', 'Pseudo déjà pris !');
            return;
        }

        // 3. Salle pleine ?
        if (game.players.length >= 6) {
            socket.emit('error', 'Salle pleine !');
            return;
        }

        // --- MODIFICATION ICI : AUTORISER SI 'ENDED' ---
        // On refuse seulement si le jeu est "EN COURS" (PLAYING)
        if (game.state === 'PLAYING') {
            socket.emit('error', 'Partie en cours, impossible de rejoindre maintenant.');
            return;
        }
        // -----------------------------------------------

        // Ajouter le joueur
        game.players.push({
            id: socket.id,
            name: playerName,
            hand: [], 
            knownCards: [], 
            score: 0
        });

        // --- GESTION DE L'AFFICHAGE SELON L'ÉTAT ---
        if (game.state === 'LOBBY') {
            // Comportement classique : on met à jour la liste d'attente
            io.to(room).emit('updateLobby', game.players.map(p => p.name));
        } 
        else if (game.state === 'ENDED') {
            // Si le jeu est fini, le nouveau joueur doit voir le tableau des scores directement
            // On envoie un message global pour dire "Un nouveau joueur est arrivé !"
            io.to(room).emit('gameMessage', `👋 ${playerName} a rejoint la partie pour le prochain tour !`);
            
            // On met à jour l'état pour tout le monde (pour que le nouveau joueur voie les scores)
            broadcastGameState(room);
        }
    });

    // Démarrer la partie
    socket.on('startGame', (room) => {
        const game = games[room];
        if (!game || game.players.length < 2) return;

        game.deck = createDeck();
        game.state = 'PLAYING';
        game.discardPile = [game.deck.pop()]; // 1 carte défausse
        game.currentPlayerIndex = 0;

        // Distribution : 4 cartes chacun
        game.players.forEach(p => {
            p.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop(), game.deck.pop()];
            // On révèle seulement 2 cartes au début (indices 0 et 1 pour simplifier, ou aléatoire)
            p.knownCards = [0, 1]; 
        });

        broadcastGameState(room);
    });

// Piocher une carte
    socket.on('drawCard', ({ room, source }) => {
        const game = games[room];
        if (!game || game.state !== 'PLAYING') return;
        
        // Sécurité : source valide uniquement
        if (source !== 'deck') return;

        const playerIdx = game.players.findIndex(p => p.id === socket.id);
        
        // 1. Est-ce mon tour ?
        if (playerIdx !== game.currentPlayerIndex) return; 

        // 2. Est-ce que j'ai déjà pioché une carte ? (LA CORRECTION EST ICI)
        if (game.drawnCard) {
            socket.emit('error', "Tu as déjà pioché ! Tu dois jouer cette carte sale batard.");
            return;
        }

        // 3. Est-ce qu'un pouvoir est en attente ?
        if (game.actionState) return; 

        // --- Exécution de la pioche ---
        let drawnCard = game.deck.pop();
        
        // Gestion pioche vide
        if (game.deck.length === 0) {
            if (game.discardPile.length > 1) {
                const topDiscard = game.discardPile.pop();
                game.deck = shuffle(game.discardPile);
                game.discardPile = [topDiscard];
                io.to(room).emit('gameMessage', '♻️ Pioche vide : La défausse a été mélangée !');
            } else {
                io.to(room).emit('gameMessage', '⚠️ Plus de cartes disponibles ! Fin de partie technique.');
                endGame(room);
                return;
            }
        }
        
        if (!drawnCard) return;

        game.drawnCard = drawnCard;
        game.drawnSource = 'deck'; 
        
        broadcastGameState(room);
    });

    // Jouer/Échanger la carte piochée
    socket.on('playAction', ({ room, action, cardIndex }) => {
        // action: 'swap' (échanger avec main) ou 'discard' (jeter la pioche)
        const game = games[room];
        if (!game || !game.drawnCard) return;

        const player = game.players.find(p => p.id === socket.id);
        const playerIdx = game.players.findIndex(p => p.id === socket.id);
        
        if (action === 'swap') {
            const oldCard = player.hand[cardIndex];
            player.hand[cardIndex] = game.drawnCard;
            player.knownCards.push(cardIndex); // La nouvelle carte est connue (posée face visible)
            addToDiscard(room, oldCard, playerIdx); // Vérifie pouvoirs
        } else if (action === 'discard') {
            if (game.drawnSource === 'discard') return; // Interdit de reprendre de la défausse pour la rejeter
            addToDiscard(room, game.drawnCard, playerIdx); // Vérifie pouvoirs
            
            // Si on défausse une carte piochée, on peut devoir la révéler si c'est une carte à effet ? 
            // Règle simplifiée ici : si on jette la pioche, c'est fini, sauf pouvoir immédiat.
        }

        game.drawnCard = null;
        game.drawnSource = null;

        // Si aucun pouvoir n'est activé par addToDiscard, on passe le tour
        if (!game.actionState) {
            nextTurn(room);
        }
        
        broadcastGameState(room);
    });

// Résoudre le pouvoir (Action effectuée)
    socket.on('resolvePower', ({ room, type, targetPlayerId, targetCardIndex, myCardIndex }) => {
        const game = games[room];
        // Vérif sécurité : est-ce bien le bon type d'action ?
        if (!game || !game.actionState || game.actionState.type !== type) return;

        const me = game.players.find(p => p.id === socket.id);
        
        // --- Exécution du pouvoir ---
        if (type === 'PEEK') { 
            const targetPlayer = game.players.find(p => p.id === me.id);
            if (targetPlayer && targetPlayer.hand[targetCardIndex]) {
                 socket.emit('peekResult', { 
                     card: targetPlayer.hand[targetCardIndex], 
                     index: targetCardIndex 
                 });
            }
        } else if (type === 'SWAP') { 
            const targetPlayer = game.players.find(p => p.id === targetPlayerId);
            if (targetPlayer && me) {
                const myCard = me.hand[myCardIndex];
                const theirCard = targetPlayer.hand[targetCardIndex];
                
                // Échange
                me.hand[myCardIndex] = theirCard;
                targetPlayer.hand[targetCardIndex] = myCard;
                
                // Oubli (Blind Swap)
                me.knownCards = me.knownCards.filter(idx => idx !== myCardIndex);
                targetPlayer.knownCards = targetPlayer.knownCards.filter(idx => idx !== targetCardIndex);
            }
        }

        // --- Gestion du tour après pouvoir ---
        const wasSnap = game.actionState.isSnap; // On sauvegarde l'info avant de reset
        game.actionState = null; // Le pouvoir est fini

        if (wasSnap) {
            // C'était un snap : On ne change PAS de joueur actif.
            // Le jeu reprend là où il en était (au joueur dont c'est le tour de piocher).
            io.to(room).emit('gameMessage', 'Pouvoir terminé, le jeu reprend.');
        } else {
            // C'était un coup normal (défausse) : Tour fini, au suivant.
            nextTurn(room);
        }
        
        broadcastGameState(room);
    });

  socket.on('skipPower', (room) => {
        const game = games[room];
        if (!game || !game.actionState) return;

        const wasSnap = game.actionState.isSnap;
        game.actionState = null;
        
        io.to(room).emit('gameMessage', 'Pouvoir ignoré.');

        if (wasSnap) {
            // Snap annulé : on reprend le jeu sans changer de tour
        } else {
            // Tour normal annulé : on passe au suivant
            nextTurn(room);
        }

        broadcastGameState(room);
    });

// "À la volée" (Snap)
    socket.on('snap', ({ room, cardIndex }) => {
        const game = games[room];
        if (!game || game.state !== 'PLAYING') return;

        const snapperIdx = game.players.findIndex(p => p.id === socket.id);
        const snapper = game.players[snapperIdx];
        
        if (!snapper || !snapper.hand[cardIndex]) return;

        const topDiscard = game.discardPile[game.discardPile.length - 1];
        const snappedCard = snapper.hand[cardIndex];

        // Vérification stricte : même valeur
        if (snappedCard.value === topDiscard.value) {
            
            // --- NOUVEAU : INTERRUPTION DU POUVOIR ---
            // Si quelqu'un (le joueur actif ou un précédent snapper) était en train de réfléchir
            if (game.actionState) {
                const previousPlayer = game.players[game.actionState.playerIdx];
                io.to(room).emit('gameMessage', `⚡ TROP LENT ! Le Snap de ${snapper.name} a annulé le pouvoir de ${previousPlayer.name} !`);
                
                // On supprime l'action en cours !
                game.actionState = null;
                
                // Note : Si c'était le tour normal d'un joueur et qu'il n'a pas fini son pouvoir,
                // techniquement le tour passe. Mais pour simplifier, on considère que le snap
                // "vole" la priorité.
            }
            // ------------------------------------------

            // SUCCÈS STANDARD DU SNAP
            game.discardPile.push(snappedCard);
            snapper.hand.splice(cardIndex, 1);
            
            // Mise à jour des index connus
            snapper.knownCards = snapper.knownCards
                .filter(i => i !== cardIndex)
                .map(i => i > cardIndex ? i - 1 : i);
            
            io.to(room).emit('gameMessage', `⚡ ${snapper.name} a réussi un "À la volée" !`);

            // DÉCLENCHEMENT DU NOUVEAU POUVOIR (Celui du Snapper)
            if (snappedCard.value === 'J') {
                game.actionState = { 
                    type: 'SWAP', 
                    playerIdx: snapperIdx, 
                    isSnap: true 
                };
                io.to(room).emit('gameMessage', `🗡️ POUVOIR VALET (Snap) !`);
            } 
            else if (snappedCard.value === 'Q') {
                game.actionState = { 
                    type: 'PEEK', 
                    playerIdx: snapperIdx, 
                    isSnap: true 
                };
                io.to(room).emit('gameMessage', `👁️ POUVOIR DAME (Snap) !`);
            }

            // Vérif fin de main
            if (snapper.hand.length === 0) triggerEndGame(room, snapper.id);

        } else {
            // ÉCHEC (Pénalité)
            const penaltyCard = game.deck.pop();
            if(penaltyCard) {
                snapper.hand.push(penaltyCard);
                io.to(room).emit('gameMessage', `❌ ${snapper.name} a raté ! (+1 carte)`);
            }
        }
        
        broadcastGameState(room);
    });

// Relancer une partie (Rejouer)
    socket.on('restartGame', (room) => {
        const game = games[room];
        if (!game || game.state !== 'ENDED') return;

        console.log(`Redémarrage de la partie dans la salle ${room}`);

        // 1. SAUVEGARDE DU DUTCH CALLER (Avant le reset !)
        const previousDutchCaller = game.dutchCaller;

        // 2. Reset complet du jeu
        game.deck = createDeck(); 
        game.discardPile = [game.deck.pop()];
        game.state = 'PLAYING';
        game.dutchCaller = null; // On remet à null pour la nouvelle partie
        game.lastRound = false;
        game.actionState = null;
        game.lastPlayerId = null;
        
        // 3. DÉFINITION DU PREMIER JOUEUR
        // On cherche l'index du joueur qui avait fait Dutch
        let starterIndex = 0; // Par défaut le premier
        
        if (previousDutchCaller) {
            const foundIndex = game.players.findIndex(p => p.id === previousDutchCaller);
            // Si le joueur est toujours dans la salle, c'est à lui
            if (foundIndex !== -1) {
                starterIndex = foundIndex;
            }
        }
        
        game.currentPlayerIndex = starterIndex;

        // 4. Redistribution des mains
        game.players.forEach(p => {
            p.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop(), game.deck.pop()];
            p.knownCards = [0, 1]; 
            p.score = 0; // (Optionnel : remettre le score à 0 ou cumuler)
        });

        // 5. Notification
        const starterName = game.players[starterIndex].name;
        io.to(room).emit('gameMessage', `🔄 Nouvelle partie ! ${starterName} commence (car il a fait Dutch).`);
        broadcastGameState(room);
    });

// Annoncer Dutch
    socket.on('callDutch', (room) => {
        const game = games[room];
        if (!game) return;

        const player = game.players.find(p => p.id === socket.id);
        const isCurrentPlayer = game.players[game.currentPlayerIndex].id === socket.id;
        
        // CONDITION 1 : C'est mon tour (je peux Dutch pendant que je joue)
        let canDutch = isCurrentPlayer;

        // CONDITION 2 (Le Buzzer) : C'était mon tour juste avant ET le suivant n'a pas encore pioché
        if (game.lastPlayerId === socket.id && !game.drawnCard) {
            canDutch = true;
        }

        if (canDutch) {
            // On vérifie qu'un Dutch n'est pas déjà actif
            if (game.lastRound) {
                 socket.emit('error', "Trop tard, le dernier tour est déjà lancé !");
                 return;
            }

            game.dutchCaller = socket.id;
            game.lastRound = true;
            
            // Si c'était le buzzer (joueur précédent), on notifie que c'était juste !
            if (!isCurrentPlayer) {
                io.to(room).emit('gameMessage', `⚡ JUSTE À TEMPS ! ${player.name} annonce DUTCH avant la pioche du suivant !`);
            } else {
                io.to(room).emit('gameMessage', `🛑 DUTCH ANNONCÉ par ${player.name} !`);
            }

            broadcastGameState(room);
        } else {
            // Si le joueur suivant a déjà pioché
            if (game.lastPlayerId === socket.id && game.drawnCard) {
                socket.emit('error', "Trop tard ! Le joueur suivant a déjà pioché.");
            }
        }
    });

// Gérer la déconnexion
    socket.on('disconnect', () => {
        for (const room in games) {
            const game = games[room];
            const playerIndex = game.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                const playerName = game.players[playerIndex].name;

                // On supprime le joueur si on est dans le LOBBY ou si la partie est FINIE (ENDED)
                // Cela permet aux gens de partir entre deux parties sans casser le jeu
                if (game.state === 'LOBBY' || game.state === 'ENDED') {
                    game.players.splice(playerIndex, 1);
                    
                    if (game.state === 'LOBBY') {
                        io.to(room).emit('updateLobby', game.players.map(p => p.name));
                    } else {
                        io.to(room).emit('gameMessage', `🚪 ${playerName} a quitté la salle.`);
                        broadcastGameState(room); // Met à jour l'affichage pour ceux qui restent
                    }

                    if (game.players.length === 0) delete games[room];
                } 
                else {
                    // Si on est en plein jeu (PLAYING), on ne supprime pas (pour éviter les crashs d'index)
                    // Mais on prévient les autres
                    io.to(room).emit('gameMessage', `⚠️ ${playerName} s'est déconnecté (AFK) !`);
                }
                break;
            }
        }
    });
});

// --- HELPER FUNCTIONS ---

function addToDiscard(room, card, playerIdx) {
    const game = games[room];
    game.discardPile.push(card);

    // Vérification des pouvoirs
    // Valet (J)
    if (card.value === 'J') {
        game.actionState = { type: 'SWAP', playerIdx: playerIdx };
    } 
    // Dame (Q)
    else if (card.value === 'Q') {
        game.actionState = { type: 'PEEK', playerIdx: playerIdx };
    }
    // Si pas de pouvoir, rien ne se passe ici, le nextTurn sera appelé par playAction
}

function nextTurn(room) {
    const game = games[room];
    
    game.lastPlayerId = game.players[game.currentPlayerIndex].id;
    // Si c'était le dernier tour et qu'on revient au caller de Dutch
    if (game.lastRound) {
        let nextIdx = (game.currentPlayerIndex + 1) % game.players.length;
        if (game.players[nextIdx].id === game.dutchCaller) {
            endGame(room);
            return;
        }
    }
    
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    
    // Si le joueur suivant n'a plus de cartes (cas rare), on passe
    if (game.players[game.currentPlayerIndex].hand.length === 0 && !game.lastRound) {
         triggerEndGame(room, game.players[game.currentPlayerIndex].id);
    }
}

function triggerEndGame(room, playerId) {
    const game = games[room];
    if (game.lastRound) return; // Déjà en cours
    game.lastRound = true;
    game.dutchCaller = playerId; // Celui qui n'a plus de carte est comme celui qui a dit Dutch
    io.to(room).emit('gameMessage', `Fin de partie déclenchée (plus de cartes) ! Dernier tour.`);
}

function endGame(room) {
    const game = games[room];
    game.state = 'ENDED';
    
    // Révéler toutes les cartes et calculer scores
    game.players.forEach(p => {
        let score = 0;
        p.hand.forEach(c => score += c.points);
        p.score = score;
        p.knownCards = p.hand.map((_, i) => i); // Tout révéler
    });
    
    broadcastGameState(room);
}

// Fonction cruciale : Envoie l'état du jeu mais cache les cartes inconnues
function broadcastGameState(room) {
    const game = games[room];
    if (!game) return;

    // Pour chaque socket dans la room, on envoie une version "nettoyée"
    const sockets = io.sockets.adapter.rooms.get(room);
    if(sockets) {
        for (const socketId of sockets) {
            const socket = io.sockets.sockets.get(socketId);
            if(socket) {
                const cleanState = JSON.parse(JSON.stringify(game)); // Deep copy
                
                // Masquer les cartes des adversaires et mes cartes inconnues
                cleanState.players.forEach(p => {
                    if (game.state !== 'ENDED') {
                        p.hand = p.hand.map((card, index) => {
                            // Si c'est moi et que je connais la carte : ok
                            if (p.id === socketId && p.knownCards.includes(index)) return card;
                            // Si la carte a été échangée et rendue visible (règle spéciale), on pourrait gérer ici
                            // Pour simplifier : on cache tout ce qui n'est pas "known"
                            return { suit: '', value: '', back: true }; 
                        });
                    }
                });
                
                // La pioche est cachée
                cleanState.deckCount = game.deck.length;
                delete cleanState.deck;

                socket.emit('gameState', cleanState);
            }
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur Dutch lancé sur le port ${PORT}`));