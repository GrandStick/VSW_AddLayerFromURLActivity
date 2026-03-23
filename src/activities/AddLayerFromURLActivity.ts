import type { IActivityHandler } from "@vertigis/workflow";
import { MapProvider } from "@vertigis/workflow/activities/arcgis/MapProvider";
import { activate } from "@vertigis/workflow/Hooks";
import type { IActivityContext } from "@vertigis/workflow/IActivityHandler";
import esriConfig from "esri/config";
import Layer from "esri/layers/Layer";
import GroupLayer from "esri/layers/GroupLayer";
import IdentityManager from "esri/identity/IdentityManager";
import ServerInfo from "esri/identity/ServerInfo";

export interface AddLayerFromURLActivityInputs {
    /**
     * @displayName Service URL
     * @description URL du FeatureServer ou d'un layer spécifique (ex: .../FeatureServer ou .../FeatureServer/0)
     * @required
     */
    layerUrl: string;
    /**
     * @displayName Token / API Key
     * @description Token ArcGIS Enterprise ou API key ArcGIS Online
     * @required
     */
    apiKey: string;
    /**
     * @displayName Charger les tables relationnelles
     * @description Si activé, charge tout le FeatureServer (couches + tables)
     */
    loadRelatedTables?: boolean;
    /**
     * @displayName URL Serveur Enterprise
     * @description URL racine ArcGIS Enterprise (ex: https://monserveur/arcgis). Vide = ArcGIS Online.
     */
    serverUrl?: string;
}

export interface AddLayerFromURLActivityOutputs {
    /** @description Message de résultat */
    result: string;
    /** @description Nombre de tables ajoutées dans map.tables */
    relatedTablesCount: number;
    /** @description Nombre de couches spatiales ajoutées dans map.layers */
    layersCount: number;
}

/**
 * @displayName Add Layer From URL
 * @category Custom Activities
 * @description Ajoute un FeatureService complet (couches + tables relationnelles) à la carte depuis une URL.
 * @supportedApps GWV
 */
@activate(MapProvider)
export class AddLayerFromURLActivity implements IActivityHandler {
    static action = "uuid:54d89237-c25e-4f3f-90db-d969e51bb0ed::AddLayerFromURLActivity";
    static suite = "uuid:54d89237-c25e-4f3f-90db-d969e51bb0ed";

    async execute(
        inputs: AddLayerFromURLActivityInputs,
        context: IActivityContext,
        type: typeof MapProvider
    ): Promise<AddLayerFromURLActivityOutputs> {
        const { layerUrl, apiKey, loadRelatedTables = true, serverUrl } = inputs;

        if (!layerUrl) throw new Error("'layerUrl' est requis.");
        if (!apiKey) throw new Error("'apiKey' est requis.");

        // --- Authentification ---
        if (serverUrl) {
            const serverInfo = new (ServerInfo as any)({
                server: serverUrl,
                tokenServiceUrl: `${serverUrl}/sharing/rest/generateToken`,
            });
            (IdentityManager as any).registerServers([serverInfo]);
            (IdentityManager as any).registerToken({ server: serverUrl, token: apiKey });
        } else {
            (esriConfig as any).apiKey = apiKey;
        }

        // --- Carte ---
        const mapProvider = type.create();
        await mapProvider.load();
        const map = mapProvider.map;
        if (!map) throw new Error("La carte n'est pas disponible.");

        // --- Dériver l'URL du service (strip /0, /1... si présent) ---
        // Accepte aussi bien .../FeatureServer que .../FeatureServer/0
        const serviceUrl = /\/\d+$/.test(layerUrl)
            ? layerUrl.substring(0, layerUrl.lastIndexOf("/"))
            : layerUrl;

        let layersCount = 0;
        let relatedTablesCount = 0;

        if (!loadRelatedTables) {
            // Mode simple : ajoute uniquement la couche spécifiée
            const singleLayer = new (Layer as any)({ url: layerUrl });
            await (singleLayer as any).load();
            map.add(singleLayer);
            layersCount = 1;
            return {
                result: `Couche ajoutée : ${layerUrl}`,
                relatedTablesCount: 0,
                layersCount: 1,
            };
        }

        // --- Méthode robuste : charger tout le FeatureServer ---
        const loaded = await (Layer as any).fromArcGISServerUrl({
            url: serviceUrl,
            properties: {
                // Passe le token pour les services sécurisés Enterprise
                ...(serverUrl ? {} : {}),
            },
        });

        if (loaded && (loaded as any).type === "group") {
            // FeatureServer multi-couches → GroupLayer
            const group = loaded as any;

            // Couches spatiales
            for (const child of group.layers?.items ?? []) {
                if ((child as any).isTable) {
                    map.tables.add(child);
                    relatedTablesCount++;
                } else {
                    map.add(child);
                    layersCount++;
                }
            }

            // Tables standalone (non spatiales exposées par le service)
            for (const table of group.tables?.items ?? []) {
                map.tables.add(table);
                relatedTablesCount++;
            }

        } else if (loaded) {
            // Service avec une seule couche
            if ((loaded as any).isTable) {
                map.tables.add(loaded);
                relatedTablesCount++;
            } else {
                map.add(loaded);
                layersCount++;
            }
        } else {
            throw new Error(`Impossible de charger le service depuis : ${serviceUrl}`);
        }

        return {
            result: `Service chargé : ${layersCount} couche(s) + ${relatedTablesCount} table(s) depuis ${serviceUrl}`,
            relatedTablesCount,
            layersCount,
        };
    }
}
