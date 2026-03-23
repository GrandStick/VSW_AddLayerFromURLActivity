import type { IActivityHandler } from "@vertigis/workflow";
import { MapProvider } from "@vertigis/workflow/activities/arcgis/MapProvider";
import { activate } from "@vertigis/workflow/Hooks";
import type { IActivityContext } from "@vertigis/workflow/IActivityHandler";
import * as esriConfig from "esri/config";
import FeatureLayer from "esri/layers/FeatureLayer";
import * as IdentityManager from "esri/identity/IdentityManager";
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
    /** @description Nombre de tables relationnelles trouvées et ajoutées */
    relatedTablesCount: number;
    /** @description Debug: contenu brut des relationships du service */
    debugRelationships: string;
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
        type: typeof MapProvider
    ): Promise<AddLayerFromURLActivityOutputs> {
        const { layerUrl, apiKey, loadRelatedTables = true, serverUrl } = inputs;

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

        // --- Carte ---
        const mapProvider = type.create();
        await mapProvider.load();
        const map = mapProvider.map;
        if (!map) throw new Error("La carte n'est pas disponible.");

        // --- Couche principale ---
        const layer = new (FeatureLayer as any)({ url: layerUrl });
        await layer.load();
        map.add(layer);
        console.log("[AddLayerFromURL] Couche principale ajoutée:", layerUrl);

        const relationships = layer.relationships ?? [];
        const debugRelationships = JSON.stringify(relationships);
        console.log("[AddLayerFromURL] Relationships trouvées:", debugRelationships);

        if (!loadRelatedTables || relationships.length === 0) {
            return {
                result: `Couche ajoutée : ${layerUrl} (${relationships.length} relation(s) dans le service)`,
                relatedTablesCount: 0,
                debugRelationships,
            };
        }

        // --- Related tables ---
        // L'URL de base du service (sans le /0 final)
        const baseUrl = /\/\d+$/.test(layerUrl)
            ? layerUrl.substring(0, layerUrl.lastIndexOf("/"))
            : layerUrl;

        const addedTableIds: number[] = [];
        const errors: string[] = [];

        for (const rel of relationships) {
            const relId: number = rel.relatedTableId;
            if (addedTableIds.includes(relId)) continue;

            const relUrl = `${baseUrl}/${relId}`;
            const relatedLayer = new (FeatureLayer as any)({ url: relUrl });

            try {
                await relatedLayer.load();
                console.log(`[AddLayerFromURL] Table ID ${relId} chargée - isTable: ${relatedLayer.isTable}, geometryType: ${relatedLayer.geometryType}`);

                if (relatedLayer.isTable) {
                    // Table non spatiale : map.tables (ArcGIS JS API)
                    // ⚠️ map.tables ne notifie pas VertiGIS directement
                    // → les tables doivent aussi être dans le webmap pour être vues dans Feature Details
                    map.tables.add(relatedLayer);
                    console.log(`[AddLayerFromURL] Table ID ${relId} ajoutée dans map.tables`);
                } else {
                    // Couche spatiale : map.layers via map.add()
                    map.add(relatedLayer);
                    console.log(`[AddLayerFromURL] Table ID ${relId} ajoutée dans map.layers`);
                }
                addedTableIds.push(relId);
            } catch (err: any) {
                const msg = `Table ID ${relId} (${relUrl}) : ${err?.message ?? err}`;
                console.warn("[AddLayerFromURL] Erreur:", msg);
                errors.push(msg);
            }
        }

        const tableMsg = addedTableIds.length > 0
            ? `+ ${addedTableIds.length} table(s) [IDs: ${addedTableIds.join(", ")}]`
            : "(aucune table ajoutée)";

        const errorMsg = errors.length > 0
            ? ` | Erreurs: ${errors.join(" / ")}`
            : "";

        return {
            result: `Couche ajoutée ${tableMsg}${errorMsg}`,
            relatedTablesCount: addedTableIds.length,
            debugRelationships,
        };
    }
}
