import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, MessageSquare, Users, Zap, CheckCircle2 } from 'lucide-react';
import { supabase } from '@/utils/supabase';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export default function Register() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    companyName: '',
    email: '',
    password: '',
    phone: '',
    agreeTerms: false,
  });

  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const validateForm = () => {
    const errors: Record<string, string> = {};
    if (!formData.firstName.trim()) errors.firstName = 'First name is required';
    if (!formData.lastName.trim()) errors.lastName = 'Last name is required';
    if (!formData.companyName.trim()) errors.companyName = 'Company name is required';
    
    if (!formData.email.trim()) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      errors.email = 'Please enter a valid email address';
    }
    
    if (!formData.password) {
      errors.password = 'Password is required';
    } else if (formData.password.length < 8) {
      errors.password = 'Password must be at least 8 characters';
    }
    
    if (!formData.agreeTerms) {
      errors.agreeTerms = 'You must agree to the Terms of Service';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
    // Clear field-specific error when user starts typing
    if (formErrors[name]) {
      setFormErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    
    if (!validateForm()) return;
    
    setLoading(true);
    try {
      // 1. Create Supabase Auth User.
      // Names/company go into user_metadata so server-side code (e.g. the
      // instagram-oauth Edge Function's onboarding repair) can reuse them.
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: {
          data: {
            first_name: formData.firstName,
            last_name: formData.lastName,
            company_name: formData.companyName,
          },
        },
      });

      if (authError) throw authError;

      // Email confirmation enabled: there is no session yet, so the
      // RLS-protected inserts below would fail and leave a half-onboarded
      // account (auth user without organization membership). Ask the user
      // to confirm their email first instead.
      if (!authData.session) {
        setError(
          'Account created. Please confirm your email address, then sign in to finish setting up your organization.'
        );
        return;
      }

      const userId = authData.user?.id;
      if (!userId) throw new Error('Failed to retrieve user ID after registration.');

      // 2. Create Profile
      const { error: profileError } = await supabase.from('profiles').insert({
        id: userId,
        first_name: formData.firstName,
        last_name: formData.lastName,
        phone: formData.phone || null,
      });

      if (profileError) {
        throw new Error(`Profile creation failed: ${profileError.message}`);
      }

      // 3. Create Organization
      const { data: orgData, error: orgError } = await supabase.from('organizations').insert({
        name: formData.companyName,
      }).select().single();

      if (orgError) {
        throw new Error(`Organization creation failed: ${orgError.message}`);
      }

      // 4. Create Organization Membership
      // (This row is what the instagram-oauth Edge Function uses to resolve
      // the tenant — never a profiles.organization_id column.)
      const { error: memberError } = await supabase.from('organization_members').insert({
        organization_id: orgData.id,
        user_id: userId,
        role: 'owner',
      });

      if (memberError) {
        throw new Error(`Organization membership failed: ${memberError.message}`);
      }

      // Registration successful, navigate to dashboard
      navigate('/dashboard');
      
    } catch (err) {
      console.error(err);
      const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred during registration.';
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-background">
      {/* Left side: Registration Form */}
      <div className="w-full lg:w-1/2 flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-24">
        <div className="w-full max-w-md mx-auto">
          <div className="mb-8">
            <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Create your account</h1>
            <p className="text-muted-foreground">Start managing your social conversations and customer data in one place.</p>
          </div>

          {error && (
            <div className="mb-6 p-4 rounded-md bg-destructive/10 text-destructive text-sm flex items-start">
              <span className="font-medium">{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="firstName">First name <span className="text-destructive">*</span></label>
                <Input 
                  id="firstName" name="firstName" 
                  value={formData.firstName} onChange={handleInputChange}
                  className={formErrors.firstName ? 'border-destructive' : ''}
                  disabled={loading}
                />
                {formErrors.firstName && <p className="mt-1 text-xs text-destructive">{formErrors.firstName}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="lastName">Last name <span className="text-destructive">*</span></label>
                <Input 
                  id="lastName" name="lastName" 
                  value={formData.lastName} onChange={handleInputChange}
                  className={formErrors.lastName ? 'border-destructive' : ''}
                  disabled={loading}
                />
                {formErrors.lastName && <p className="mt-1 text-xs text-destructive">{formErrors.lastName}</p>}
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="companyName">Company / Business name <span className="text-destructive">*</span></label>
              <Input 
                id="companyName" name="companyName" 
                value={formData.companyName} onChange={handleInputChange}
                className={formErrors.companyName ? 'border-destructive' : ''}
                disabled={loading}
              />
              {formErrors.companyName && <p className="mt-1 text-xs text-destructive">{formErrors.companyName}</p>}
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="email">Email <span className="text-destructive">*</span></label>
              <Input 
                id="email" name="email" type="email" 
                value={formData.email} onChange={handleInputChange}
                className={formErrors.email ? 'border-destructive' : ''}
                disabled={loading}
              />
              {formErrors.email && <p className="mt-1 text-xs text-destructive">{formErrors.email}</p>}
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="password">Password <span className="text-destructive">*</span></label>
              <div className="relative">
                <Input 
                  id="password" name="password" 
                  type={showPassword ? 'text' : 'password'} 
                  value={formData.password} onChange={handleInputChange}
                  className={formErrors.password ? 'border-destructive pr-10' : 'pr-10'}
                  disabled={loading}
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowPassword(!showPassword)}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              {formErrors.password && <p className="mt-1 text-xs text-destructive">{formErrors.password}</p>}
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="phone">Phone number <span className="text-muted-foreground font-normal">(optional)</span></label>
              <Input 
                id="phone" name="phone" type="tel" 
                value={formData.phone} onChange={handleInputChange}
                disabled={loading}
              />
            </div>

            <div className="flex items-start pt-2">
              <div className="flex h-5 items-center">
                <input
                  id="agreeTerms"
                  name="agreeTerms"
                  type="checkbox"
                  checked={formData.agreeTerms}
                  onChange={handleInputChange}
                  className="h-4 w-4 rounded border-input text-primary focus:ring-primary disabled:opacity-50"
                  disabled={loading}
                />
              </div>
              <div className="ml-3 text-sm">
                <label htmlFor="agreeTerms" className={`font-medium ${formErrors.agreeTerms ? 'text-destructive' : 'text-foreground'}`}>
                  I agree to the Terms of Service and Privacy Policy.
                </label>
                {formErrors.agreeTerms && <p className="mt-1 text-xs text-destructive">{formErrors.agreeTerms}</p>}
              </div>
            </div>

            <Button type="submit" className="w-full mt-4" disabled={loading}>
              {loading ? 'Creating account...' : 'Create account'}
            </Button>
          </form>

          <div className="mt-8 text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link to="/auth/login" className="font-medium text-primary hover:underline">
              Log in
            </Link>
          </div>
        </div>
      </div>

      {/* Right side: Value Proposition */}
      <div className="w-full lg:w-1/2 bg-primary text-primary-foreground p-12 flex flex-col justify-center relative overflow-hidden">
        {/* Abstract background shape */}
        <div className="absolute top-0 right-0 -mr-20 -mt-20 w-96 h-96 rounded-full bg-white opacity-5 blur-3xl"></div>
        <div className="absolute bottom-0 left-0 -ml-20 -mb-20 w-80 h-80 rounded-full bg-white opacity-10 blur-3xl"></div>
        
        <div className="max-w-md mx-auto relative z-10">
          <div className="mb-10">
            <h2 className="text-3xl font-bold mb-4">The all-in-one AI Social CRM</h2>
            <p className="text-primary-foreground/80 text-lg">
              Streamline your workflow, engage customers, and turn conversations into revenue automatically.
            </p>
          </div>

          <div className="space-y-8">
            <div className="flex items-start">
              <div className="flex-shrink-0 mt-1">
                <div className="w-10 h-10 rounded-full bg-primary-foreground/10 flex items-center justify-center">
                  <MessageSquare className="w-5 h-5 text-primary-foreground" />
                </div>
              </div>
              <div className="ml-4">
                <h3 className="text-lg font-semibold">Unified Inbox</h3>
                <p className="text-primary-foreground/70 mt-1">Connect Meta accounts and manage Facebook & Instagram DMs from a single dashboard.</p>
              </div>
            </div>

            <div className="flex items-start">
              <div className="flex-shrink-0 mt-1">
                <div className="w-10 h-10 rounded-full bg-primary-foreground/10 flex items-center justify-center">
                  <Users className="w-5 h-5 text-primary-foreground" />
                </div>
              </div>
              <div className="ml-4">
                <h3 className="text-lg font-semibold">Smarter Lead Management</h3>
                <p className="text-primary-foreground/70 mt-1">Automatically extract customer details and track opportunities through your pipeline.</p>
              </div>
            </div>

            <div className="flex items-start">
              <div className="flex-shrink-0 mt-1">
                <div className="w-10 h-10 rounded-full bg-primary-foreground/10 flex items-center justify-center">
                  <Zap className="w-5 h-5 text-primary-foreground" />
                </div>
              </div>
              <div className="ml-4">
                <h3 className="text-lg font-semibold">AI-Powered Intelligence</h3>
                <p className="text-primary-foreground/70 mt-1">Generate intent-aware replies and automate routine conversations instantly.</p>
              </div>
            </div>
          </div>
          
          <div className="mt-12 p-4 bg-primary-foreground/10 rounded-lg flex items-center">
            <CheckCircle2 className="w-5 h-5 text-green-300 mr-3 flex-shrink-0" />
            <p className="text-sm text-primary-foreground/90">Join forward-thinking businesses upgrading their sales stack today.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
