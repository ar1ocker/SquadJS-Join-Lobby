//@ts-check
import BasePlugin from "./base-plugin.js";
import axios from "axios";
import express from "express";

const SQUAD_GAME_ID = 393380;

export default class JoinLobby extends BasePlugin {
  static get description() {
    return "JoinLobbyID";
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      port: {
        required: true,
      },

      steamApiKey: {
        required: true,
      },

      removeOutdatedInterval: {
        required: true,
        example: 30,
      },
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.lobbyIDCache = new Map();

    this.lastIDIndex = 0;
    this.app = express();

    this.app.use((req, res, next) => {
      res.append("Access-Control-Allow-Origin", ["*"]);
      res.append("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE");
      res.append("Access-Control-Max-Age", "120");
      next();
    });

    this.app.get("/server_link", (req, res) => {
      let lobbyID = this.getFromCacheWithRoundRobin();

      if (lobbyID) {
        res.json({ link: `steam://joinlobby/${SQUAD_GAME_ID}/${lobbyID}/` });
        return;
      }

      res.status(418).json({ data: "Доступные лобби не найдены" });
    });

    this.app.get("/info", (req, res) => {
      res.json({ name: this.server.serverName, count_players: this.server.players.length });
    });

    this.app.get("/steam/:steamID", (req, res) => {
      const steamID = req.params.steamID;

      if (this.server.players.find((player) => player.steamID == steamID)) {
        res.json({ status: true });
      } else {
        res.json({ status: false });
      }
    });
  }

  async cachePlayerLobbyIDFacade(steamIDs) {
    let steamIDLobbyIDMap = await this.searchPlayerLobbyID(steamIDs, this.options.steamApiKey);

    if (steamIDLobbyIDMap) {
      this.updateCache(steamIDLobbyIDMap);
    }
  }

  async searchPlayerLobbyID(steamIDs, apiKey) {
    try {
      let steamIDsText = steamIDs.join(",");

      let response = await axios.get(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v1/?key=${apiKey}&steamids=${steamIDsText}`
      );

      let playersData = response.data?.response?.players.player;

      this.verbose(2, JSON.stringify(playersData));

      if (!playersData) {
        return;
      }

      let retMap = new Map();

      for (const playerData of playersData) {
        this.verbose(playerData);
        if (playerData.gameid != SQUAD_GAME_ID) {
          this.verbose(2, `Не подходит gameid у ${playerData.steamID} - ${playerData.gameid}`);
          continue;
        }

        if (playerData.lobbysteamid) {
          retMap.set(playerData.steamid, playerData.lobbysteamid);
        } else {
          this.verbose(2, `Нет lobbysteamid ${playerData.steamid}`);
        }
      }

      return retMap;
    } catch (error) {
      this.verbose(1, `Failed to fetch GetPlayerSummaries: ${error.message}, ${JSON.stringify(error.response?.data)}`);
    }
  }

  async cacheAllPlayersLobbyId() {
    let steamIDs = this.server.players.map((player) => player.steamID);
    steamIDs = steamIDs.filter((steamID) => steamID != undefined);

    if (steamIDs) {
      await this.cachePlayerLobbyIDFacade(steamIDs);
    }
  }

  async removeOutdatedLobbyID() {
    for (let steamID of this.lobbyIDCache.keys()) {
      let player = this.server.players.find((player) => player.steamID == steamID);

      if (!player) {
        this.lobbyIDCache.delete(steamID);
        this.verbose(2, `Очищено lobbyID игрока ${steamID}`);
      }
    }
  }

  updateCache(steamIDLobbyIDMap) {
    for (let [steamID, lobbyID] of steamIDLobbyIDMap.entries()) {
      this.lobbyIDCache.set(steamID, lobbyID);
    }
  }

  removeFromCache(steamID) {
    this.lobbyIDCache.delete(steamID);
  }

  getFromCacheWithRoundRobin() {
    let lobbyIds = Array.from(this.lobbyIDCache.values());
    let countIDs = lobbyIds.length;

    if (countIDs === 0) {
      return;
    }

    this.lastIDIndex = (this.lastIDIndex + 1) % countIDs;
    return lobbyIds[this.lastIDIndex];
  }

  async mount() {
    this.app.listen(this.options.port, () => {
      console.log(`Express JoinLobby run on the port ${this.options.port}`);
    });

    this.server.on("PLAYER_CONNECTED", async (data) => {
      if (data.player) {
        this.cachePlayerLobbyIDFacade([data.player.steamID]);
      }
    });

    this.server.on("PLAYER_DISCONNECTED", (data) => {
      if (data.player) {
        this.removeFromCache(data.player.steamID);
      }
    });

    if (this.server.players.length > 0) {
      await this.cacheAllPlayersLobbyId();
    }

    setInterval(() => this.removeOutdatedLobbyID(), this.options.removeOutdatedInterval * 1000);

    this.verbose(1, `Found lobby ID: ${this.lobbyIDCache.size}`);
  }
}
