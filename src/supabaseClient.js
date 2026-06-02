import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lgkavgibyqrgwewkopga.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxna2F2Z2lieXFyZ3dld2tvcGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0MTA2NjksImV4cCI6MjA5MTk4NjY2OX0.Un0r4iT5c6EGf7KJkB48Mf7IQL9p9r0Zqb2JNN6Vd5Q';

export const supabase = createClient(supabaseUrl, supabaseKey);
