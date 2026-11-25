-- DecorBiz Step 1 (Item 4): Settings > Integrations credential slots
-- Ensures every credentialed optional feature has an AES-256-GCM encrypted slot in public.integration_settings
-- and cleans up legacy branding in display_name.

UPDATE public.integration_settings
SET display_name = 'DecorBiz AI Provider'
WHERE integration_key = 'ai_provider'
  AND display_name = 'BizOne AI Provider';

INSERT INTO public.integration_settings (integration_key, enabled, display_name, config_public, status)
VALUES
  (
    'online_payments',
    false,
    'Online Payments Gateway',
    '{"provider": "razorpay", "mode": "test", "key_id": "", "base_url": ""}'::jsonb,
    'not_configured'
  ),
  (
    'online_store',
    false,
    'Online Storefront & Webhook',
    '{"base_url": "", "pickup_enabled": "true", "cod_enabled": "true"}'::jsonb,
    'not_configured'
  )
ON CONFLICT (integration_key) DO NOTHING;
