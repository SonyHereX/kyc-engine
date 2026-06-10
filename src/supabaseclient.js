import { createClient } from '@supabase/supabase-js';

// Replace these with YOUR Supabase project details from the Project Settings -> API page.
// The current values were pointing to a test project!
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://lgkavgibyqrgwewkopga.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxna2F2Z2lieXFyZ3dld2tvcGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MTA2NjksImV4cCI6MjA5MTk4NjY2OX0.Un0r4iT5c6EGf7KJkB48Mf7IQL9p9r0Zqb2JNN6Vd5Q';

export const supabase = createClient(supabaseUrl, supabaseKey);
