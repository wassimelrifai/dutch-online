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
        playerName = (playerName || "").trim();
        room = (room || "").trim();
        
        if (!playerName || !room) {
            socket.emit('error', 'Pseudo et salle requis !');
            return;
        }

        socket.join(room);
        
        // 1. Création si n'existe pas
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
                pendingDutch: false,
                lastPlayerId: null,
                turnPhase: 'ACTION',
                leaderId: null 
            };
        }

        const game = games[room];

        // 2. Sécurités 
        if (game.players.find(p => p.id === socket.id)) return;
        
        const nameTaken = game.players.find(p => p.name.toLowerCase() === playerName.toLowerCase());
        if (nameTaken) {
            socket.emit('error', 'Pseudo déjà pris !');
            return; 
        }

        if (game.players.length >= 6) {
            socket.emit('error', 'Salle pleine !');
            return;
        }
        if (game.state === 'PLAYING') {
            socket.emit('error', 'Partie en cours...');
            return;
        }

        // 3. Ajout du joueur
        game.players.push({
            id: socket.id,
            name: playerName,
            hand: [], 
            knownCards: [], 
            score: 0,
            totalScore: 0
        });

        // Gestion du Chef
        const leaderExists = game.players.find(p => p.id === game.leaderId);
        if (!game.leaderId || !leaderExists) {
            game.leaderId = game.players[0].id;
        }

        // 4. Notification
        if (game.state === 'LOBBY') {
            io.to(room).emit('updateLobby', { 
                players: game.players.map(p => p.name), 
                leaderId: game.leaderId 
            });
        } 
        else if (game.state === 'ENDED') {
            io.to(room).emit('gameMessage', `👋 ${playerName} a rejoint pour le prochain tour !`);
            broadcastGameState(room);
            io.to(room).emit('updateLobby', { 
                players: game.players.map(p => p.name), 
                leaderId: game.leaderId 
            });
        }
    });

    // Démarrer la partie
    socket.on('startGame', (room) => {
        const game = games[room];
        if (!game || game.players.length < 2) return;

        if (game.leaderId !== socket.id) {
            socket.emit('error', "Seul le Chef de la salle peut lancer la partie !");
            return;
        }

        game.deck = createDeck();
        game.state = 'PLAYING';
        game.discardPile = [game.deck.pop()]; 
        game.currentPlayerIndex = 0;

        // Distribution : 4 cartes chacun
        game.players.forEach(p => {
            p.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop(), game.deck.pop()];
            p.knownCards = [0, 1]; 
        });

        broadcastGameState(room);
    });

// Piocher une carte
    socket.on('drawCard', ({ room, source }) => {
        const game = games[room];
        if (!game || game.state !== 'PLAYING') return;
        
        if (game.endingTimer) {
            socket.emit('error', "La partie est finie ! Seuls les Snaps sont autorisés.");
            return;
        }
        if (source !== 'deck') return;

        const playerIdx = game.players.findIndex(p => p.id === socket.id);
        if (playerIdx !== game.currentPlayerIndex) return; 

        if (game.drawnCard) {
            socket.emit('error', "Tu as déjà pioché !");
            return;
        }

        if (game.actionState) return; 

        // --- Exécution de la pioche ---
        let drawnCard = game.deck.pop();
        
        // Gestion pioche vide (Mélange défausse)
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

        // 1. INFO PRIVÉE IMMÉDIATE (Pour que le joueur n'attende pas)
        // On envoie la carte tout de suite à celui qui joue
        socket.emit('privateCardDrawn', drawnCard);

        // 2. ANIMATION PUBLIQUE (Pour que tout le monde voie le mouvement)
        io.to(room).emit('animate', {
            type: 'DRAW',
            playerId: socket.id
        });

        // 3. MISE À JOUR ÉTAT SERVEUR
        game.drawnCard = drawnCard;
        game.drawnSource = 'deck'; 
        
        // 4. SYNCHRONISATION GLOBALE DIFFÉRÉE
        // Les autres joueurs attendront la fin de l'animation pour voir le résultat fixe
        broadcastWithDelay(room, 900);
    });

    // Jouer/Échanger la carte piochée
    socket.on('playAction', ({ room, action, cardIndex }) => {
        const game = games[room];
        if (!game || !game.drawnCard) return;

        const player = game.players.find(p => p.id === socket.id);
        const playerIdx = game.players.findIndex(p => p.id === socket.id);
        
        if (action === 'swap') {
            const oldCard = player.hand[cardIndex];
            
            // Animation Swap
            io.to(room).emit('animate', {
                type: 'SWAP_SELF',
                playerId: socket.id,
                cardIndex: cardIndex
            });

            player.hand[cardIndex] = game.drawnCard;
            player.knownCards.push(cardIndex); 
            addToDiscard(room, oldCard, playerIdx); 

        } else if (action === 'discard') {
            if (game.drawnSource === 'discard') return;
            
            // Animation Discard
            io.to(room).emit('animate', {
                type: 'DISCARD_DRAWN',
                playerId: socket.id
            });

            addToDiscard(room, game.drawnCard, playerIdx); 
        }

        game.drawnCard = null;
        game.drawnSource = null;

        if (!game.actionState) {
            nextTurn(room);
        }
        
        broadcastWithDelay(room, 900);
    });

// Résoudre le pouvoir
    socket.on('resolvePower', ({ room, type, targetPlayerId, targetCardIndex, myCardIndex }) => {
        const game = games[room];
        if (!game || !game.actionState || game.actionState.type !== type) return;

        const me = game.players.find(p => p.id === socket.id);
        
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

                io.to(room).emit('animate', {
                    type: 'SWAP_PLAYERS',
                    fromId: me.id,
                    fromIndex: myCardIndex,
                    toId: targetPlayer.id,
                    toIndex: targetCardIndex
                });
                
                const myCard = me.hand[myCardIndex];
                const theirCard = targetPlayer.hand[targetCardIndex];
                
                me.hand[myCardIndex] = theirCard;
                targetPlayer.hand[targetCardIndex] = myCard;
                
                me.knownCards = me.knownCards.filter(idx => idx !== myCardIndex);
                targetPlayer.knownCards = targetPlayer.knownCards.filter(idx => idx !== targetCardIndex);
            }
        }

        const wasSnap = game.actionState.isSnap; 
        game.actionState = null; 

        if (wasSnap) {
            io.to(room).emit('gameMessage', 'Pouvoir terminé, le jeu reprend.');
        } else {
            nextTurn(room);
        }

        // Délai long pour le Valet (3s), court pour la Dame
        const delay = (type === 'SWAP') ? 3100 : 1000;
        broadcastWithDelay(room, delay);
    });

  socket.on('skipPower', (room) => {
        const game = games[room];
        if (!game || !game.actionState) return;

        const wasSnap = game.actionState.isSnap;
        game.actionState = null;
        
        io.to(room).emit('gameMessage', 'Pouvoir ignoré.');

        if (!wasSnap) {
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

        if (snappedCard.value === topDiscard.value) {
            
            if (game.actionState) {
                const previousPlayer = game.players[game.actionState.playerIdx];
                io.to(room).emit('gameMessage', `⚡ TROP LENT ! Le Snap de ${snapper.name} a annulé le pouvoir de ${previousPlayer.name} !`);
                game.actionState = null;
            }

            io.to(room).emit('animate', {
                type: 'SNAP',
                playerId: socket.id,
                cardIndex: cardIndex
            });

            game.discardPile.push(snappedCard);
            snapper.hand.splice(cardIndex, 1);
            
            snapper.knownCards = snapper.knownCards
                .filter(i => i !== cardIndex)
                .map(i => i > cardIndex ? i - 1 : i);
            
            io.to(room).emit('gameMessage', `⚡ ${snapper.name} a réussi un "À la volée" !`);

            if (snappedCard.value === 'J') {
                game.actionState = { type: 'SWAP', playerIdx: snapperIdx, isSnap: true };
                io.to(room).emit('gameMessage', `🗡️ POUVOIR VALET (Snap) !`);
            } 
            else if (snappedCard.value === 'Q') {
                game.actionState = { type: 'PEEK', playerIdx: snapperIdx, isSnap: true };
                io.to(room).emit('gameMessage', `👁️ POUVOIR DAME (Snap) !`);
            }

            if (snapper.hand.length === 0) triggerEndGame(room, snapper.id);

        } else {
            const penaltyCard = game.deck.pop();
            if(penaltyCard) {
                snapper.hand.push(penaltyCard);
                io.to(room).emit('gameMessage', `❌ ${snapper.name} a raté ! (+1 carte)`);
            }
        }
        
        broadcastWithDelay(room, 900);
    });

// Relancer une partie
    socket.on('restartGame', (room) => {
        const game = games[room];
        if (!game || game.state !== 'ENDED') return;

        if (game.leaderId !== socket.id) {
            socket.emit('error', "Seul le Chef de la salle peut relancer la partie !");
            return;
        }

        if (game.players.length < 2) {
            socket.emit('error', "Impossible de lancer la partie seul !");
            return;
        }

        const previousDutchCaller = game.dutchCaller;

        game.deck = createDeck(); 
        game.discardPile = [game.deck.pop()];
        game.state = 'PLAYING';
        game.dutchCaller = null; 
        game.lastRound = false;
        game.actionState = null;
        game.lastPlayerId = null;
        if(game.endingTimer) clearTimeout(game.endingTimer);
        game.endingTimer = null;
        
        let starterIndex = 0; 
        if (previousDutchCaller) {
            const foundIndex = game.players.findIndex(p => p.id === previousDutchCaller);
            if (foundIndex !== -1) starterIndex = foundIndex;
        }
        
        game.currentPlayerIndex = starterIndex;

        // 4. Redistribution des mains
        game.players.forEach(p => {
            p.hand = [game.deck.pop(), game.deck.pop(), game.deck.pop(), game.deck.pop()];
            p.knownCards = [0, 1]; 
            p.score = null; // On efface le score de la manche précédente
            // p.totalScore reste intact !
        });

        const starterName = game.players[starterIndex].name;
        io.to(room).emit('gameMessage', `🔄 Nouvelle partie ! ${starterName} commence.`);
        broadcastGameState(room);
    });

// Annoncer Dutch
    socket.on('callDutch', (room) => {
        const game = games[room];
        if (!game) return;

        const player = game.players.find(p => p.id === socket.id);
        const isCurrentPlayer = game.players[game.currentPlayerIndex].id === socket.id;
        
        let canDutch = false;

        // CAS A : Je suis le JOUEUR ACTIF
        if (isCurrentPlayer) {
            canDutch = true;
        }
        // CAS B : Je suis le JOUEUR PRÉCÉDENT (Buzzer)
        else if (game.lastPlayerId === socket.id && !game.drawnCard && !game.actionState) {
            canDutch = true;
        }

        if (canDutch) {
            if (game.lastRound) {
                 socket.emit('error', "Trop tard, le dernier tour est déjà lancé !");
                 return;
            }

            game.dutchCaller = socket.id;
            game.lastRound = true;
            
            if (!isCurrentPlayer) {
                io.to(room).emit('gameMessage', `⚡ JUSTE À TEMPS ! ${player.name} annonce DUTCH avant la pioche !`);
            } else {
                io.to(room).emit('gameMessage', `🛑 DUTCH ANNONCÉ par ${player.name} !`);
            }

            broadcastGameState(room);
        } else {
            if (game.lastPlayerId === socket.id) {
                if (game.drawnCard) socket.emit('error', "Trop tard ! Le joueur suivant a déjà pioché.");
                else if (game.actionState) socket.emit('error', "Trop tard ! Le joueur suivant a déjà joué sa carte.");
            }
        }
    });

    socket.on('leaveGame', (room) => {
        handlePlayerLeave(room, socket.id);
        socket.emit('leftGameSuccess');
    });

    socket.on('disconnect', () => {
        for (const room in games) {
            const game = games[room];
            if (game.players.find(p => p.id === socket.id)) {
                handlePlayerLeave(room, socket.id);
                break;
            }
        }
    });
});

// --- HELPER FUNCTIONS ---

function addToDiscard(room, card, playerIdx) {
    const game = games[room];
    game.discardPile.push(card);

    if (card.value === 'J') {
        game.actionState = { type: 'SWAP', playerIdx: playerIdx };
    } 
    else if (card.value === 'Q') {
        game.actionState = { type: 'PEEK', playerIdx: playerIdx };
    }
}

function nextTurn(room) {
    const game = games[room];
    
    game.lastPlayerId = game.players[game.currentPlayerIndex].id;
    
    // GESTION FIN DE MANCHE
    if (game.lastRound) {
        let nextIdx = (game.currentPlayerIndex + 1) % game.players.length;
        
        if (game.players[nextIdx].id === game.dutchCaller) {
            
            if (game.endingTimer) return;

            io.to(room).emit('gameMessage', `⏳ Fin de partie dans 4 secondes... SNAPPEZ VITE !`);
            
            game.endingTimer = setTimeout(() => {
                endGame(room);
            }, 4000); 

            return; 
        }
    }
    
    game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
    
    if (game.players[game.currentPlayerIndex].hand.length === 0 && !game.lastRound) {
         triggerEndGame(room, game.players[game.currentPlayerIndex].id);
    }
}

function triggerEndGame(room, playerId) {
    const game = games[room];
    if (game.lastRound) return; 
    game.lastRound = true;
    game.dutchCaller = playerId; 
    io.to(room).emit('gameMessage', `Fin de partie déclenchée (plus de cartes) ! Dernier tour.`);
}

function endGame(room) {
    const game = games[room];
    if (!game) return;

    if (game.endingTimer) {
        clearTimeout(game.endingTimer);
        game.endingTimer = null;
    }
    game.state = 'ENDED';
    
    // Révéler toutes les cartes et calculer scores
    game.players.forEach(p => {
        let roundScore = 0;
        p.hand.forEach(c => roundScore += c.points);
        
        // On sauvegarde le score de la manche (pour l'affichage immédiat)
        p.score = roundScore;
        
        // On l'ajoute au total (Cumul)
        if (!p.totalScore) p.totalScore = 0;
        p.totalScore += roundScore;
        
        p.knownCards = p.hand.map((_, i) => i); // Tout révéler
    });
    
    broadcastGameState(room);
}

function broadcastGameState(room) {
    const game = games[room];
    if (!game) return;

    const sockets = io.sockets.adapter.rooms.get(room);
    if(sockets) {
        for (const socketId of sockets) {
            const socket = io.sockets.sockets.get(socketId);
            if(socket) {
                // On exclut endingTimer pour éviter le bug JSON
                const { endingTimer, ...safeGameData } = game;
                const cleanState = JSON.parse(JSON.stringify(safeGameData)); 
                
                cleanState.players.forEach(p => {
                    if (game.state !== 'ENDED') {
                        p.hand = p.hand.map((card, index) => {
                            if (p.id === socketId && p.knownCards.includes(index)) return card;
                            return { suit: '', value: '', back: true }; 
                        });
                    }
                });
                
                cleanState.deckCount = game.deck.length;
                delete cleanState.deck;

                socket.emit('gameState', cleanState);
            }
        }
    }
}

function handlePlayerLeave(room, socketId) {
    const game = games[room];
    if (!game) return;

    const playerIndex = game.players.findIndex(p => p.id === socketId);
    if (playerIndex === -1) return;

    const player = game.players[playerIndex];
    const handToCheck = player.hand; 

    game.players.splice(playerIndex, 1);

    if (game.players.length === 0) {
        delete games[room];
        return;
    }

    if (game.leaderId === socketId) {
        game.leaderId = game.players[0].id;
        io.to(room).emit('gameMessage', `👑 ${game.players[0].name} est maintenant le Chef de la salle !`);
    }

    if (game.state === 'PLAYING') {
        if (game.players.length < 2) {
            game.state = 'ENDED'; 
            game.dutchCaller = null;
            game.lastRound = false;
            game.actionState = null;
            game.pendingDutch = false;
            game.turnPhase = 'ACTION';
            game.drawnCard = null;
            game.lastPlayerId = null;

            io.to(room).emit('gameMessage', `🚫 ${player.name} est parti. Partie annulée.`);
            broadcastGameState(room);
            io.to(room).emit('updateLobby', { 
                players: game.players.map(p => p.name), 
                leaderId: game.leaderId 
            });
            return; 
        }

        if (handToCheck.length > 0) {
            const topCard = game.discardPile.pop();
            game.discardPile.push(...handToCheck);
            game.discardPile = shuffle(game.discardPile);
            game.discardPile.push(topCard);
        }

        if (playerIndex < game.currentPlayerIndex) {
            game.currentPlayerIndex--;
        } else if (playerIndex === game.currentPlayerIndex) {
            if (game.currentPlayerIndex >= game.players.length) {
                game.currentPlayerIndex = 0;
            }
            game.drawnCard = null;
            game.drawnSource = null;
            game.actionState = null;
            game.turnPhase = 'ACTION';
            game.pendingDutch = false;
        }

        if (game.dutchCaller === socketId) {
            game.dutchCaller = null;
            game.lastRound = false;
        }
        if (game.lastPlayerId === socketId) game.lastPlayerId = null;

        broadcastGameState(room);
    }

    io.to(room).emit('updateLobby', { 
        players: game.players.map(p => p.name), 
        leaderId: game.leaderId 
    });
    
    io.to(room).emit('gameMessage', `🚪 ${player.name} a quitté la partie.`);
}

function broadcastWithDelay(room, delay) {
    setTimeout(() => {
        broadcastGameState(room);
    }, delay);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur Dutch lancé sur le port ${PORT}`));