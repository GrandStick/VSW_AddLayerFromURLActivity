import type { IActivityHandler } from "@vertigis/workflow";
import { MapProvider } from "@vertigis/workflow/activities/arcgis/MapProvider";
import { activate } from "@vertigis/workflow/Hooks";
import type { IActivityContext } from "@vertigis/workflow/IActivityHandler";
import esriConfig from "esri/config";
import FeatureLayer from "esri/layers/FeatureLayer";
import IdentityManager from "esri/identity/IdentityManager";
import ServerInfo from "esri/identity/ServerInfo";

export interface AddLayerFromURLActivityInputs {
    /** @displayName Layer URL @description URL de la feature layer (ex: .../FeatureServer/0) @required */
    layerUrl: string;
    /** @displayName Token / API Key @description Token ArcGIS Enterprise ou API key ArcGIS Online @required */
    apiKey: string;
    /** @displayName Charger les tables relationnelles @description Détecte et ajoute automatiquement les related tables */
    loadRelatedTables?: boolean;
    /** @displayName URL Serveur Enterprise @description URL racine ArcGIS Enterprise (ex: https://monserveur/arcgis). Vide = ArcGIS Online. */
    serverUrl?: string;
}

export interface AddLayerFromURLActivityOutputs {
    /** @description Message de résultat */
    result: string;
    /** @description Nombre de tables relationnelles ajoutées */
    relatedTablesCount: number;
}

/**
 * @displayName Add Layer From URL
 * @category Custom Activities
 * @description Ajoute une feature layer et ses tables relationnelles à la carte depuis une URL.
 * @supportedApps GWV
 */
@activate(MapProvider)
export class AddLayerFromURLActivity implements IActivityHandler {
    static action = "uuid:54d89237-c25e-4f3f-90db-d969e51bb0ed::AddLayerFromURLActivity";
    static suite = "uuid:54d89237-c25e-4f3f-90db-d969e51bb0ed";

    async execute(
        inputs: AddLayerFromURLActivityInputs,
        context: IActivityContext,
        type: typeof MapProvider       // ← typeof, pas MapProvider directement
    ): Promise<AddLayerFromURLActivityOutputs> {
        const { layerUrl, apiKey, loadRelatedTables = true, serverUrl } = inputs;

        if (!layerUrl) throw new Error("'layerUrl' est requis.");
        if (!apiKey) throw new Error("'apiKey' est requis.");

        // --- Authentification ---
        if (serverUrl) {
            const serverInfo = new ServerInfo({
                server: serverUrl,
                tokenServiceUrl: `${serverUrl}/sharing/rest/generateToken`,
            });
            IdentityManager.registerServers([serverInfo]);
            IdentityManager.registerToken({ server: serverUrl, token: apiKey });
        } else {
            esriConfig.apiKey = apiKey;
        }

        // --- Accès à la carte via type.create() ---
        const mapProvider = type.create();   // ← type.create(), pas mapProvider.create()
        await mapProvider.load();
        const map = mapProvider.map;
        if (!map) throw new Error("La carte n'est pas disponible.");

        // --- Ajout de la couche principale ---
        const layer = new FeatureLayer({ url: layerUrl });
        await layer.load();
        map.add(layer);

        if (!loadRelatedTables) {
            return { result: `Couche ajoutée : ${layerUrl}`, relatedTablesCount: 0 };
        }

        // --- Related tables ---
        const baseUrl = layerUrl.substring(0, layerUrl.lastIndexOf("/"));
        const relationships = layer.relationships ?? [];
        const addedTableIds: number[] = [];

        for (const rel of relationships) {
            const relId = rel.relatedTableId;
            if (addedTableIds.includes(relId)) continue;

            const relatedLayer = new FeatureLayer({ url: `${baseUrl}/${relId}` });
            try {
                await relatedLayer.load();
                if (!relatedLayer.geometryType) {
                    map.tables.add(relatedLayer);   // table non spatiale
                } else {
                    map.add(relatedLayer);           // couche spatiale
                }
                addedTableIds.push(relId);
            } catch (err) {
                console.warn(`[AddLayerFromURL] Table ID ${relId} non chargeable :`, err);
            }
        }

        const tableMsg = addedTableIds.length > 0
            ? `+ ${addedTableIds.length} table(s) relationnelle(s) [IDs: ${addedTableIds.join(", ")}]`
            : "(aucune table relationnelle détectée)";

        return {
            result: `Couche ajoutée ${tableMsg} depuis : ${layerUrl}`,
            relatedTablesCount: addedTableIds.length,
        };
    }
}
