const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());

// Inicializar Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Meta credentials
const META_TOKEN = process.env.META_TOKEN;
const ACCOUNT_ID = process.env.ACCOUNT_ID;

// Obtener campañas de Meta
async function fetchMetaCampaigns() {
    try {
        const url = `https://graph.instagram.com/v18.0/act_${ACCOUNT_ID}/campaigns`;
        const params = {
            fields: 'id,name,status,spend,impressions,reach,cost_per_action_type,action_values',
            access_token: META_TOKEN
        };

        const response = await axios.get(url, { params });
        
        if (!response.data.data) {
            throw new Error('No campaigns found');
        }

        return response.data.data.map(campaign => {
            const purchaseValue = campaign.action_values ? 
                campaign.action_values.find(av => av.action_type === 'purchase')?.value : 0;
            const costPerAction = campaign.cost_per_action_type ? 
                campaign.cost_per_action_type.find(cpa => cpa.action_type === 'purchase')?.value : 0;

            const spent = parseFloat(campaign.spend) || 0;
            const impressions = parseInt(campaign.impressions) || 0;

            return {
                meta_id: campaign.id,
                name: campaign.name,
                status: campaign.status || 'ACTIVE',
                spent: spent,
                impressions: impressions,
                reach: parseInt(campaign.reach) || 0,
                roas: purchaseValue && spent ? (parseFloat(purchaseValue) / spent).toFixed(2) : 0,
                cpm: impressions > 0 ? (spent * 1000 / impressions).toFixed(2) : 0,
                conversions: costPerAction ? Math.round(spent / parseFloat(costPerAction)) : 0,
                fetched_at: new Date().toISOString()
            };
        });
    } catch (error) {
        console.error('Error fetching Meta campaigns:', error.message);
        throw error;
    }
}

// Sincronizar datos con Supabase
async function syncToSupabase() {
    try {
        const campaigns = await fetchMetaCampaigns();
        
        // Guardar en Supabase
        for (const campaign of campaigns) {
            const { error } = await supabase
                .from('campaigns')
                .upsert([campaign], { onConflict: 'meta_id' });
            
            if (error) throw error;
        }

        console.log(`Synced ${campaigns.length} campaigns to Supabase`);
        return { success: true, count: campaigns.length };
    } catch (error) {
        console.error('Error syncing to Supabase:', error.message);
        throw error;
    }
}

// API Endpoint - Obtener campañas
app.get('/api/campaigns', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('campaigns')
            .select('*')
            .order('fetched_at', { ascending: false });

        if (error) throw error;

        // Calcular resumen
        const active = data.filter(c => c.spent > 0);
        const summary = {
            totalSpent: active.reduce((s, c) => s + c.spent, 0),
            totalConversions: active.reduce((s, c) => s + c.conversions, 0),
            avgRoas: active.length > 0 ? 
                (active.reduce((s, c) => s + parseFloat(c.roas), 0) / active.length).toFixed(2) : 0,
            avgCpm: active.length > 0 ? 
                (active.reduce((s, c) => s + parseFloat(c.cpm), 0) / active.length).toFixed(2) : 0
        };

        res.json({ success: true, data, summary });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API Endpoint - Sincronizar ahora
app.post('/api/sync', async (req, res) => {
    try {
        const result = await syncToSupabase();
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API Endpoint - Generar informe semanal
app.get('/api/weekly-report', async (req, res) => {
    try {
        const { dateFrom, dateTo } = req.query;

        const { data, error } = await supabase
            .from('campaigns')
            .select('*')
            .gte('fetched_at', dateFrom)
            .lte('fetched_at', dateTo);

        if (error) throw error;

        const active = data.filter(c => c.spent > 0);
        const report = {
            period: { from: dateFrom, to: dateTo },
            totalSpent: active.reduce((s, c) => s + c.spent, 0),
            totalConversions: active.reduce((s, c) => s + c.conversions, 0),
            avgRoas: active.length > 0 ? 
                (active.reduce((s, c) => s + parseFloat(c.roas), 0) / active.length).toFixed(2) : 0,
            topCampaign: active.length > 0 ? 
                active.reduce((p, c) => parseFloat(c.roas) > parseFloat(p.roas) ? c : p) : null,
            campaigns: active
        };

        res.json({ success: true, report });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
    // Sincronizar al iniciar
    syncToSupabase().catch(err => console.error('Initial sync failed:', err));
});

// Sincronizar cada 24 horas
setInterval(() => {
    syncToSupabase().catch(err => console.error('Scheduled sync failed:', err));
}, 24 * 60 * 60 * 1000);
