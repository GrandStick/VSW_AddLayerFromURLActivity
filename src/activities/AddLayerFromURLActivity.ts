import type { IActivityHandler } from "@vertigis/workflow";
import { MapProvider } from "@vertigis/workflow/activities/arcgis/MapProvider";
import { activate } from "@vertigis/workflow/Hooks";
import type { IActivityContext } from "@vertigis/workflow/IActivityHandler";
import * as esriConfig from "esri/config";
import FeatureLayer from "esri/layers/FeatureLayer";
import * as IdentityManager from "esri/identity/IdentityManager";
import ServerInfo from "esri/identity/ServerInfo";

export interface AddLayerFromURLActivityInputs {
    /**
     * @displayName Layer URL
     * @description URL of a FeatureServer or a specific layer (.../FeatureServer or .../FeatureServer/0). Add the url avec the relation tables if you want it to be added
     * @required
     */
    layerUrl: string;
    /**
     * @displayName Token / API Key
     * @description  ArcGIS Enterprise Token or ArcGIS Online API key 
     * @required
     */
    apiKey: string;
    /**
     * @displayName Load relationship tables (true/false)
     * @description Détecte et ajoute automatiquement les related tables
     */
    loadRelatedTables?: boolean;
    /**
     * @displayName Enterprise server URL
     * @description URL of the rooot of ArcGIS Enterprise (ex: https://myserver/arcgis). Empty = ArcGIS Online.
     */
    serverUrl?: string;
    /**
     * @displayName Map ID
     * @description ID of the Map target. Use the default map if empty.
     */
    mapId?: string;
}

export interface AddLayerFromURLActivityOutputs {
    /** @description Result message*/
    result: string;
    /** @description Number of related tables added */
    relatedTablesCount: number;
    /** @description Debug: relationships brutes du service */
    debugRelationships: string;
    /** @description ID of the main layer added — usable in Get Layer */
    layerId: string;
    /** @description IDs of the related tables added */
    relatedTableIds: string[];
}

/**
 * @displayName Add Layer From URL
 * @category Custom Activities
 * @description Add a feature layer to the map from a URL, with optional related tables. Supports ArcGIS Online and Enterprise (token or API key).
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
        const { layerUrl, apiKey, loadRelatedTables = true, serverUrl, mapId } = inputs;

        if (!layerUrl) throw new Error("'layerUrl' est requis.");
        if (!apiKey) throw new Error("'apiKey' est requis.");

        // --- Authentification ---
        if (serverUrl) {
            const info = new (ServerInfo as any)({
                server: serverUrl,
                tokenServiceUrl: `${serverUrl}/sharing/rest/generateToken`,
            });
            (IdentityManager as any).registerServers([info]);
            (IdentityManager as any).registerToken({ server: serverUrl, token: apiKey });
        } else {
            (esriConfig as any).apiKey = apiKey;
        }

        // --- Carte : réutiliser le provider sans le recréer ---
        const mapProvider = type.create();
        await mapProvider.load();

        // Si mapId fourni, cibler la bonne carte, sinon carte par défaut
        const map = mapId
            ? (mapProvider as any).getMap?.(mapId) ?? mapProvider.map
            : mapProvider.map;

        if (!map) throw new Error("La carte n'est pas disponible.");

        // --- Normaliser l'URL : /FeatureServer → /FeatureServer/0 ---
        const isRootUrl = /\/FeatureServer\/?$/i.test(layerUrl);
        const normalizedUrl = isRootUrl
            ? layerUrl.replace(/\/?$/, "") + "/0"
            : layerUrl;
        const baseUrl = normalizedUrl.substring(0, normalizedUrl.lastIndexOf("/"));

        // --- Couche principale ---
        const layer = new (FeatureLayer as any)({ url: normalizedUrl });
        await layer.load();
        map.add(layer);

        // ✅ Capturer l'ID assigné après map.add()
        const layerId: string = layer.id;

        const relationships = layer.relationships ?? [];
        const debugRelationships = JSON.stringify(relationships);

        if (!loadRelatedTables || relationships.length === 0) {
            return {
                result: `Couche ajoutée : ${normalizedUrl} | ${relationships.length} relation(s) dans le service`,
                relatedTablesCount: 0,
                debugRelationships,
                layerId,
                relatedTableIds: [],
            };
        }

        // --- Related tables ---
        const addedTableIds: number[] = [];
        const relatedTableIds: string[] = [];
        const errors: string[] = [];

        for (const rel of relationships) {
            const relId: number = rel.relatedTableId;
            if (addedTableIds.includes(relId)) continue;

            const relatedLayer = new (FeatureLayer as any)({ url: `${baseUrl}/${relId}` });
            try {
                await relatedLayer.load();
                map.add(relatedLayer); // Always map.layers for related records to work
                relatedTableIds.push(relatedLayer.id);
                addedTableIds.push(relId);
            } catch (err: any) {
                errors.push(`ID ${relId}: ${err?.message ?? err}`);
            }
        }

        const tableMsg = addedTableIds.length > 0
            ? `+ ${addedTableIds.length} table(s) [IDs: ${addedTableIds.join(", ")}]`
            : "(aucune table ajoutée)";

        return {
            result: `Couche ajoutée ${tableMsg} depuis : ${normalizedUrl}${errors.length ? " | Erreurs: " + errors.join(", ") : ""}`,
            relatedTablesCount: addedTableIds.length,
            debugRelationships,
            layerId,              // ✅ ID couche principale
            relatedTableIds,      // ✅ IDs tables liées
        };
    }
}
