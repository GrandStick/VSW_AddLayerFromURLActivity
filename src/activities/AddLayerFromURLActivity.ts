import type { IActivityHandler } from "@vertigis/workflow";
import { MapProvider } from "@vertigis/workflow/activities/arcgis/MapProvider";
import { activate } from "@vertigis/workflow/Hooks";
import type { IActivityContext } from "@vertigis/workflow/IActivityHandler";
import  FeatureLayer from "esri/layers/FeatureLayer";
import * as IdentityManager from "esri/identity/IdentityManager";
import  ServerInfo from "esri/identity/ServerInfo";

export interface AddLayerFromURLActivityInputs {
    /**
     * @displayName Layer URL
     * @description URL of a FeatureServer or a specific layer (.../FeatureServer or .../FeatureServer/0).
     * @required
     */
    layerUrl: string;
    /**
     * @displayName Token / API Key
     * @description ArcGIS Enterprise Token or ArcGIS Online API key.
     * @required
     */
    apiKey: string;
    /**
     * @displayName Load relationship tables
     * @description Automatically detect and add related tables from the service.
     */
    loadRelatedTables?: boolean;
    /**
     * @displayName Enterprise server URL
     * @description Root URL of ArcGIS Enterprise (ex: https://myserver/arcgis). Empty = ArcGIS Online.
     */
    serverUrl?: string;
    /**
     * @displayName Map ID
     * @description ID of the target map. Uses the default map if empty.
     */
    mapId?: string;
}

export interface AddLayerFromURLActivityOutputs {
    /** @description Result message */
    result: string;
    /** @description Number of related tables added */
    relatedTablesCount: number;
    /** @description Debug: raw relationships from the service */
    debugRelationships: string;
    /** @description ID of the main layer added — usable in Get Layer */
    layerId: string;
    /** @description IDs of the related tables added */
    relatedTableIds: string[];
}

/**
 * @displayName Add Layer From URL
 * @category Custom Activities
 * @description Add a feature layer to the map from a URL, with optional related tables. Supports ArcGIS Online and Enterprise (token or API key). Version 30-03-2026  (10:19)
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

        if (!layerUrl) throw new Error("'layerUrl' is required.");
        if (!apiKey) throw new Error("'apiKey' is required.");

        // --- Normaliser l'URL : /FeatureServer → /FeatureServer/0 ---
        const isRootUrl = /\/FeatureServer\/?$/i.test(layerUrl);
        const normalizedUrl = isRootUrl
            ? layerUrl.replace(/\/?$/, "") + "/0"
            : layerUrl;
        const baseUrl = normalizedUrl.substring(0, normalizedUrl.lastIndexOf("/"));

        // --- Authentification : ciblée par domaine, pas globale ---
        // ✅ Chaque service a son propre token → plusieurs couches avec des keys différentes coexistent
        if (serverUrl) {
            // Enterprise
            const info = new (ServerInfo as any)({
                server: serverUrl,
                tokenServiceUrl: `${serverUrl}/sharing/rest/generateToken`,
            });
            (IdentityManager as any).registerServers([info]);
            (IdentityManager as any).registerToken({
                server: serverUrl,
                token: apiKey,
                ssl: true,
            });
        } else {
            // ArcGIS Online : enregistrer sur le domaine exact du service
            // ✅ Ne touche plus à esriConfig.apiKey (global et écrasable)
            const serviceOrigin = new URL(normalizedUrl).origin;
            (IdentityManager as any).registerToken({
                server: serviceOrigin,
                token: apiKey,
                ssl: true,
            });
        }

        // --- Carte ---
        const mapProvider = type.create();
        await mapProvider.load();

        const map = mapId
            ? (mapProvider as any).getMap?.(mapId) ?? mapProvider.map
            : mapProvider.map;

        if (!map) throw new Error("Map is not available.");

        // --- Couche principale ---
        const layer = new (FeatureLayer as any)({ url: normalizedUrl });
        await layer.load();
        map.add(layer);

        const layerId: string = layer.id;
        const relationships = layer.relationships ?? [];
        const debugRelationships = JSON.stringify(relationships);

        if (!loadRelatedTables || relationships.length === 0) {
            return {
                result: `Layer added: ${normalizedUrl} | ${relationships.length} relation(s) in service`,
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
                map.add(relatedLayer);

                // ✅ Empêche les erreurs de rendu et d'identify
                relatedLayer.listMode = "hide";
                relatedLayer.popupEnabled = false;

                relatedTableIds.push(relatedLayer.id);
                addedTableIds.push(relId);
            } catch (err: any) {
                errors.push(`ID ${relId}: ${err?.message ?? err}`);
            }
        }

        const tableMsg = addedTableIds.length > 0
            ? `+ ${addedTableIds.length} related table(s) [IDs: ${addedTableIds.join(", ")}]`
            : "(no related tables added)";

        return {
            result: `Layer added ${tableMsg} from: ${normalizedUrl}${errors.length ? " | Errors: " + errors.join(", ") : ""}`,
            relatedTablesCount: addedTableIds.length,
            debugRelationships,
            layerId,
            relatedTableIds,
        };
    }
}
