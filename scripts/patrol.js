class Patrol {
  constructor() {
    this.tokens = [];
    this.characters = [];
    this.occupiedPositions = [];
    this.executePatrol = false;
    this.started = false;
    this.delay = game.settings.get(MODULE_NAME_PATROL, "patrolDelay") || 2500;
    this.diagonals = game.settings.get(MODULE_NAME_PATROL, "patrolDiagonals") || false;
    this.resetToRandomNode = game.settings.get(MODULE_NAME_PATROL, "resetToRandomNode") || false;
    this.DEBUG = false;
  }

  static get() {
    return new Patrol();
  }

  mapTokens() {
    console.log("Map tokens");
    if (this.tokens.some(token => token.alerted || token.alertTimedOut)) return;

    this.tokens = [];

    // First we add the tokens that are on random patrol
    canvas.tokens.placeables
      .filter((t) =>
        // if patrol is enabled
        t.document.getFlag(MODULE_NAME_PATROL, "enablePatrol") &&
        // if the token is not defeated
        !t.actor?.effects?.find(e => e.getFlag("core", "statusId") === CONFIG.Combat.defeatedStatusId)
      )
      .forEach((t) => {
        // Random Patrol tokens could be contained in a drawing
        // So we assign the drawing to the token if it is a drawing
        // Drawings have the text "Patrol"
        let tokenDrawing = canvas.drawings.placeables
          .filter((d) => d.document.text == "Patrol")
          .map((d) => new PIXI.Polygon(this.adjustPolygonPoints(d)))
          .find(poly => poly.contains(t.center.x, t.center.y));
        
        // Or patrol tokens can be assigned to a path.
        const paths = canvas.drawings
          .placeables.filter((d) => d.document.text === t.document.getFlag(MODULE_NAME_PATROL, "patrolPathName"));

        // Then we add the token to the list of tokens
        this.tokens.push({
          tokenDocument: t,
          visitedPositions: [{x: t.x, y: t.y}],
          patrolPolygon: tokenDrawing,
          patrolPaths: paths,
          currentPathIndex: 0,
          currentNodeIndex: this.resetToRandomNode ? undefined : 0,
          canSpot: t.document.getFlag(MODULE_NAME_PATROL, "enableSpotting"),
          alerted:false,
          alertTimedOut:false,
          spottedToken: undefined,
          chasePositions: [],
        });
      });
    
    // We also keep a reference of character tokens
    this.characters = canvas.tokens.placeables.filter(
      (t) => t.actor && (t.actor?.type == "character" || t.actor?.type == "char" || t.actor?.hasPlayerOwner)
    );

    // We store the occupied positions
    this.occupiedPositions = this.characters.map((t) => {
      return {x: t.x, y: t.y};
    }).concat(this.tokens.map((t) => {
      return {x: t.tokenDocument.x, y: t.tokenDocument.y};
    }));
  }

  async patrolSetDelay(ms) {
    setTimeout(() => {
      this.executePatrol = true;
    }, ms);
  }

  async patrolAlertTimeout(ms,token) {
    setTimeout(() => {
      token.alertTimedOut = true;
      token.alerted = false;
    }, ms);
  }

  patrolStart() {
    this.patrolSetDelay(this.delay);
    canvas.app.ticker.add(this.patrolCompute.bind(this));
  }

  patrolStop() {
    canvas.app.ticker.remove(this.patrolCompute);
  }

  patrolCompute() {
    if (
      this.executePatrol &&
      !game.paused &&
      !game.combat?.started &&
      this.started
    ) {
      // Some performance metrics
      let perfStart, perfEnd;
      if (this.DEBUG) perfStart = performance.now();

      // Init variables
      this.executePatrol = false;
      this.patrolSetDelay(this.delay);

      let updates = [];

      // Here we go through all the tokens and move them
      for (let token of this.tokens) {
        if (token.spottedToken) {
          this.occupiedPositions.push({x: token.spottedToken.x, y:token.spottedToken.y});
        }
        // If selected, just skip
        if (token.tokenDocument.controlled) continue;

        let newPosition;
  
        if (token.canSpot && this.detectPlayer(token)) {
          // If the token can spot and detect a player, try to chase them
          if (token.alerted) {
            // If the token is alerted
            // Move to the spotted token
            const directions = this.getDirections(token.tokenDocument);
            newPosition = directions.reduce((previousPoint, currentPoint) => {
              return canvas.grid.measureDistance(currentPoint.center, token.spottedToken.center) <
                canvas.grid.measureDistance(previousPoint.center, token.spottedToken.center)
                ? currentPoint : previousPoint;
            });
            // Make sure to push the current position to return to the current position
            token.chasePositions.push({x: token.tokenDocument.x, y: token.tokenDocument.y});
            token.chasePositions.push(newPosition);
          } else {
            // This means the token is spotted the player
            continue;
          }
        } else {
          // If the token can't spot, patrol
          if (token.chasePositions.length > 0) {
            // If the token has chased a player, move back to the last position
            newPosition = token.chasePositions.pop();
          } else {
            // else Patrol
            newPosition = token.tokenDocument.document.getFlag(MODULE_NAME_PATROL, "isPathPatroller")
              ? this.pathPatrolHandler(token)
              : this.randomPatrolHandler(token);
          }
        }
        if (newPosition) {
          updates.push({
            _id: token.tokenDocument.id,
            ...newPosition,
          });
        }
      }

      // After we have moved all the tokens, we update the scene
      canvas.scene.updateEmbeddedDocuments("Token", updates);

      // Some performance metrics
      if (this.DEBUG) {
        perfEnd = performance.now();
        console.log(
          `Patrol compute took ${perfEnd - perfStart} ms, FPS:${Math.round(
            canvas.app.ticker.FPS
          )}`
        );
      }
    }
  }

  getValidPositions(token) {
    let validPositions = [];
    // Find valid positions to move to
    this.getDirections(token.tokenDocument).forEach((d) => {
      if (
        // has the token visited this position already?
        !token.visitedPositions.some((p) => p.x === d.x && p.y === d.y) &&
        // is the position not occupied?
        !this.occupiedPositions.some((p) => p.x === d.x && p.y === d.y) &&
        // is the position in the patrol polygon?
        (!token.patrolPolygon ||
          token.patrolPolygon.contains(d.center.x, d.center.y)) &&
        // is there a wall in the way?
        !token.tokenDocument.checkCollision(d.center)
      )
        validPositions.push(d);
    });
    // If the token is alerted, we can move closer to the player
    if(token.alerted && validPositions.length != 0){
      const reducer = (previousPoint, currentPoint) => {
          return canvas.grid.measureDistance(currentPoint.center, token.spottedToken.center) <
            canvas.grid.measureDistance(previousPoint.center,  token.spottedToken.center)
            ? currentPoint
            : previousPoint;
      };
      return [validPositions.reduce(reducer)]
    }
    return validPositions;
  }

  getDirections(token) {
    let g = canvas.dimensions.size;
    let positions = [
      {
        x: token.x + g,
        y: token.y,
        center: { x: token.center.x + g, y: token.center.y },
      },
      {
        x: token.x - g,
        y: token.y,
        center: { x: token.center.x - g, y: token.center.y },
      },
      {
        x: token.x,
        y: token.y + g,
        center: { x: token.center.x, y: token.center.y + g },
      },
      {
        x: token.x,
        y: token.y - g,
        center: { x: token.center.x, y: token.center.y - g },
      },
    ];
    if (this.diagonals) {
      positions.push(
        {
          x: token.x + g,
          y: token.y + g,
          center: { x: token.center.x + g, y: token.center.y + g },
        },
        {
          x: token.x - g,
          y: token.y - g,
          center: { x: token.center.x - g, y: token.center.y - g },
        },
        {
          x: token.x - g,
          y: token.y + g,
          center: { x: token.center.x - g, y: token.center.y + g },
        },
        {
          x: token.x + g,
          y: token.y - g,
          center: { x: token.center.x + g, y: token.center.y - g },
        }
      );
    }
    for(let pos of positions){
      let snapped = canvas.grid.getSnappedPosition(pos.x,pos.y)
      pos.x = snapped.x
      pos.y = snapped.y
      let snappedCenter = canvas.grid.getCenter(pos.center.x,pos.center.y)
      pos.center.x = snappedCenter[0]
      pos.center.y = snappedCenter[1]
    }
    return positions
  }

  adjustPolygonPoints(drawing) 
  {
      let globalCoords = [];
      if (drawing.document.shape.points.length != 0) {
        for(let i = 0; i < drawing.document.shape.points.length; i+=2){
            globalCoords.push(drawing.document.shape.points[i] + (drawing.x), drawing.document.shape.points[i+1] + (drawing.y));
        }
      } else {
        globalCoords = [
            drawing.bounds.left,
            drawing.bounds.top,
            drawing.bounds.right,
            drawing.bounds.top,
            drawing.bounds.right,
            drawing.bounds.bottom,
            drawing.bounds.left,
            drawing.bounds.bottom,
        ];
      }
      return globalCoords;
  }

  detectPlayer(token, preventEvent = false) {
    // This function checks if the token can spot a player
    // The flow goes None -> Spotted -> Alerted -> None
    let maxDistance = canvas.effects.illumination.globalLight
      ? 1000
      : token.tokenDocument.document.sight.range
    for (let char of this.characters) {
      if (
        canvas.grid.measureDistance(token.tokenDocument.center, char.center) <=
          maxDistance &&
          !token.tokenDocument.checkCollision(char.center,{ type: "sight" })
      ) {
        if(preventEvent) return true
        let spotter = token.tokenDocument;
        let spotted = char;
        if(game.settings.get(MODULE_NAME_PATROL, "patrolAlertDelay") == 0){
          token.alerted=true
          token.alertTimedOut=true
        }
        if(!token.alerted && !token.alertTimedOut){
          // Allow a system / module to override if something was spotted
          if (Hooks.call("prePatrolAlerted", spotter, spotted)) {
            console.log("prePatrolAlerted", spotter, spotted);
            token.alerted=true
            token.spottedToken = spotted
            this.patrolAlertTimeout(game.settings.get(MODULE_NAME_PATROL, "patrolAlertDelay"),token)
            // Inform any who want to do something with the spotted info
            Hooks.callAll("patrolAlerted", spotter, spotted);
          }
        } else if(token.alertTimedOut) {
          // Allow a system / module to override if something was spotted
          if (Hooks.call("prePatrolSpotted", spotter, spotted)) {
            token.alerted = false;
            token.alertTimedOut = false;
            token.spottedToken = undefined;
            // Inform any who want to do something with the spotted info
            Hooks.callAll("patrolSpotted", spotter, spotted);
          }
        }
        return true;
      }
    }
    if(preventEvent) return false
    token.alertTimedOut=false
    return false;
  }

  randomPatrolHandler(token) {
    // Find valid positions to move to
    let validPositions = this.getValidPositions(token);
    if (validPositions.length === 0) {
      // If no valid positions, we stay where we are
      console.warn(`${token.tokenDocument.name} is stuck at ${token.tokenDocument.x},${token.tokenDocument.y}`);
      // For good measure we just snap the token to the grid
      this.occupiedPositions.push({ x: token.tokenDocument.x, y: token.tokenDocument.y });
      token.visitedPositions.push({ x: token.tokenDocument.x, y: token.tokenDocument.y });
      // if we've been stuck here for too long, we clear the visited positions
      if (token.visitedPositions.filter(p => p.x == token.tokenDocument.x && p.y == token.tokenDocument.y).length > 1) {
        token.visitedPositions = [];
        console.log(`${token.tokenDocument.name} has been stuck for too long, clearing visited positions`);
      }
    } else {
      // If valid positions, we move to one of them
      // Choose a random position from the valid positions
      let newPosition = validPositions[Math.floor(Math.random() * validPositions.length)];
      token.visitedPositions.push({ x: newPosition.x, y: newPosition.y });
      this.occupiedPositions.push({ x: newPosition.x, y: newPosition.y });
      // Remove the token from the occupied positions
      this.occupiedPositions = this.occupiedPositions.filter(
        (pos) => pos.x !== token.tokenDocument.x || pos.y !== token.tokenDocument.y
      );
      return newPosition;
    }
  }

  pathToNodes(path) {
    const nodes = [];
    if (path.document.shape.points.length) {
      for (let i = 0; i < path.document.shape.points.length; i+=2) {
        nodes.push({ x: path.document.shape.points[i] + (path.x - 50), y: path.document.shape.points[i + 1] + (path.y - 50) });
      }
      // If the path is closed, we need to remove the last node
      if (nodes[0].x == nodes[nodes.length - 1].x && nodes[0].y == nodes[nodes.length - 1].y) {
        nodes.pop();
      }
    } 
    return nodes;
  }

  pathPatrolHandler(token) {
    if (token.patrolPaths?.length) {
      const currentPath = token.patrolPaths[token.currentPathIndex];
      const nodes = this.pathToNodes(currentPath);
      if (nodes.length === 0) {
        // If no valid positions, we stay where we are
        console.warn(`${token.tokenDocument.name} is stuck at ${token.tokenDocument.x},${token.tokenDocument.y}`);
        // For good measure we just snap the token to the grid
        this.occupiedPositions.push({ x: token.tokenDocument.x, y: token.tokenDocument.y });
      } else {
        // If the current node index is undefined, we set it to a random node
        if (token.currentNodeIndex === undefined) {
          token.currentNodeIndex = Math.floor(Math.random() * nodes.length);
        }
        // Move to the next node in the path
        const newPosition = nodes[token.currentNodeIndex];
        token.currentNodeIndex++;
        if (token.currentNodeIndex >= nodes.length) {
          token.currentNodeIndex = 0;
          token.currentPathIndex++;
          if (token.currentPathIndex >= token.patrolPaths.length) {
            token.currentPathIndex = 0;
          }
        }
        token.visitedPositions.push({ x: newPosition.x, y: newPosition.y });
        this.occupiedPositions.push({ x: newPosition.x, y: newPosition.y });
        // Remove the token from the occupied positions
        this.occupiedPositions = this.occupiedPositions.filter(
          (pos) => pos.x !== token.tokenDocument.x || pos.y !== token.tokenDocument.y
        );
        return newPosition;
      }
    } else {
      console.warn(`${token.tokenDocument.name} has no patrol paths`)
    }
  }
}
