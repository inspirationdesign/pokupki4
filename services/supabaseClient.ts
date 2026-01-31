import { createClient } from '@supabase/supabase-js';

// Supabase configuration
// These values should be set in environment variables
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials not configured. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
}

let supabaseClient;
try {
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('Supabase credentials missing!');
  }
  supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    realtime: {
      params: {
        eventsPerSecond: 10
      }
    }
  });
  console.log('Supabase client initialized');
} catch (err) {
  console.error('Failed to initialize Supabase client:', err);
}

export const supabase = supabaseClient;

// Types matching database schema
export interface DbUser {
  telegram_id: number;
  username: string | null;
  photo_url: string | null;
  family_id: number;
  last_seen: string | null;
  visit_count: number;
}

export interface DbFamily {
  id: number;
  invite_code: string;
  owner_id: number | null;
}

export interface DbItem {
  id: string;
  text: string;
  is_bought: boolean;
  category: string;
  family_id: number;
  purchase_count: number;
}

// Helper functions for database operations

export async function authUser(telegramUser: {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}): Promise<{ user: DbUser; family: DbFamily & { members: DbUser[]; is_owner: boolean } } | null> {
  if (!supabase) return null;

  // Check if user exists
  const { data: existingUser } = await supabase
    .from('users')
    .select('*, family:families(*)')
    .eq('telegram_id', telegramUser.id)
    .single();

  const currentTime = new Date().toISOString();

  if (!existingUser) {
    // Create new family for new user
    const { data: newFamily, error: familyError } = await supabase
      .from('families')
      .insert({ owner_id: telegramUser.id })
      .select()
      .single();

    if (familyError || !newFamily) {
      console.error('Error creating family:', familyError);
      return null;
    }

    // Create new user
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert({
        telegram_id: telegramUser.id,
        username: telegramUser.username || null,
        photo_url: telegramUser.photo_url || null,
        family_id: newFamily.id,
        last_seen: currentTime,
        visit_count: 1
      })
      .select()
      .single();

    if (userError || !newUser) {
      console.error('Error creating user:', userError);
      return null;
    }

    return {
      user: newUser,
      family: {
        ...newFamily,
        members: [newUser],
        is_owner: true
      }
    };
  }

  // Update existing user
  await supabase
    .from('users')
    .update({
      username: telegramUser.username || existingUser.username,
      photo_url: telegramUser.photo_url || existingUser.photo_url,
      last_seen: currentTime,
      visit_count: (existingUser.visit_count || 0) + 1
    })
    .eq('telegram_id', telegramUser.id);

  // Get family members
  const { data: members } = await supabase
    .from('users')
    .select('*')
    .eq('family_id', existingUser.family_id);

  return {
    user: existingUser,
    family: {
      ...existingUser.family,
      members: members || [],
      is_owner: existingUser.family.owner_id === telegramUser.id
    }
  };
}

export async function joinFamily(userId: number, inviteCode: string): Promise<{ family: DbFamily & { members: DbUser[]; is_owner: boolean } } | null> {
  if (!supabase) return null;
  // Find family by invite code
  const { data: family } = await supabase
    .from('families')
    .select('*')
    .eq('invite_code', inviteCode)
    .single();

  if (!family) {
    console.error('Family not found');
    return null;
  }

  // Update user's family
  await supabase
    .from('users')
    .update({ family_id: family.id })
    .eq('telegram_id', userId);

  // Get updated members
  const { data: members } = await supabase
    .from('users')
    .select('*')
    .eq('family_id', family.id);

  return {
    family: {
      ...family,
      members: members || [],
      is_owner: family.owner_id === userId
    }
  };
}

export async function leaveFamily(userId: number): Promise<{ family: DbFamily & { members: DbUser[]; is_owner: boolean } } | null> {
  if (!supabase) return null;
  // Get current user
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', userId)
    .single();

  if (!user) return null;

  // Create new family for the user
  const { data: newFamily } = await supabase
    .from('families')
    .insert({ owner_id: userId })
    .select()
    .single();

  if (!newFamily) return null;

  // Move user to new family
  await supabase
    .from('users')
    .update({ family_id: newFamily.id })
    .eq('telegram_id', userId);

  // Get updated user
  const { data: updatedUser } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', userId)
    .single();

  return {
    family: {
      ...newFamily,
      members: updatedUser ? [updatedUser] : [],
      is_owner: true
    }
  };
}

export async function removeFamilyMember(ownerId: number, targetUserId: number): Promise<{ family: DbFamily & { members: DbUser[]; is_owner: boolean } } | null> {
  if (!supabase) return null;
  // Get owner's family
  const { data: owner } = await supabase
    .from('users')
    .select('*, family:families(*)')
    .eq('telegram_id', ownerId)
    .single();

  if (!owner || owner.family.owner_id !== ownerId) {
    console.error('Not authorized');
    return null;
  }

  // Create new family for removed user
  const { data: newFamily } = await supabase
    .from('families')
    .insert({ owner_id: targetUserId })
    .select()
    .single();

  if (!newFamily) return null;

  // Move target user to new family
  await supabase
    .from('users')
    .update({ family_id: newFamily.id })
    .eq('telegram_id', targetUserId);

  // Get updated members of owner's family
  const { data: members } = await supabase
    .from('users')
    .select('*')
    .eq('family_id', owner.family_id);

  return {
    family: {
      ...owner.family,
      members: members || [],
      is_owner: true
    }
  };
}

export async function getItems(familyId: number): Promise<DbItem[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('family_id', familyId);

  if (error) {
    console.error('Error fetching items:', error);
    return [];
  }

  return data || [];
}

export async function upsertItem(item: {
  id: string;
  text: string;
  is_bought: boolean;
  category: string;
  family_id: number;
  purchase_count: number;
}): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase
    .from('items')
    .upsert(item, { onConflict: 'id' });

  if (error) {
    console.error('Error upserting item:', error);
    return false;
  }

  return true;
}

export async function deleteItem(itemId: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase
    .from('items')
    .delete()
    .eq('id', itemId);

  if (error) {
    console.error('Error deleting item:', error);
    return false;
  }

  return true;
}

// Subscribe to real-time changes for a family's items
export function subscribeToItems(
  familyId: number,
  onInsert: (item: DbItem) => void,
  onUpdate: (item: DbItem) => void,
  onDelete: (itemId: string) => void
) {
  if (!supabase) return () => { };
  const channel = supabase
    .channel(`items:family_${familyId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'items',
        filter: `family_id=eq.${familyId}`
      },
      (payload) => onInsert(payload.new as DbItem)
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'items',
        filter: `family_id=eq.${familyId}`
      },
      (payload) => onUpdate(payload.new as DbItem)
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'items',
        filter: `family_id=eq.${familyId}`
      },
      (payload) => onDelete((payload.old as any).id)
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
