'use client';
import { createTheme, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';

export const workspaceTheme = createTheme({
  primaryColor: 'petrol',
  primaryShade: { light: 7, dark: 7 },
  defaultRadius: 'sm',
  fontFamily: 'var(--sans)',
  fontFamilyMonospace: 'var(--mono)',
  fontSizes: { xs: '.8125rem', sm: '.875rem', md: '.875rem', lg: '1rem', xl: '1.25rem' },
  lineHeights: { xs: '1.385', sm: '1.43', md: '1.43', lg: '1.5', xl: '1.4' },
  radius: { xs: '.375rem', sm: '.5rem', md: '.75rem', lg: '1rem', xl: '1.5rem' },
  spacing: { xs: '.5rem', sm: '.75rem', md: '1rem', lg: '1.5rem', xl: '2rem' },
  headings: {
    fontFamily: 'var(--sans)', fontWeight: '600',
    sizes: { h1: { fontSize: '1.875rem', lineHeight: '1.2' }, h2: { fontSize: '1.25rem', lineHeight: '1.4' }, h3: { fontSize: '1.125rem', lineHeight: '1.4' } },
  },
  colors: {
    petrol: ['#effaf9', '#d6efed', '#b5e1df', '#8cd1ce', '#68bfbd', '#359e9f', '#15898e', '#006f78', '#005a62', '#06444d'],
    indigo: ['#effaf9', '#d6efed', '#b5e1df', '#8cd1ce', '#68bfbd', '#359e9f', '#15898e', '#006f78', '#005a62', '#06444d'],
    green: ['#edf6ef', '#d8eddf', '#b3dcc1', '#83c49b', '#55a977', '#35885a', '#237549', '#1c653e', '#155231', '#113e27'],
    yellow: ['#fcf3e5', '#f5e2c1', '#efd09b', '#dfb571', '#c29449', '#aa7630', '#925c0b', '#7c4e09', '#653f0a', '#4c310a'],
    orange: ['#fcf3e5', '#f5e2c1', '#efd09b', '#dfb571', '#c29449', '#aa7630', '#925c0b', '#7c4e09', '#653f0a', '#4c310a'],
    red: ['#fff0f0', '#f8d8da', '#efb4b9', '#e28b92', '#d26a73', '#c14d57', '#b23a43', '#9b2e39', '#7c2530', '#601d28'],
    dark: ['#e9f0f3', '#cbd8df', '#b3c3cc', '#708995', '#526975', '#334954', '#263a46', '#182731', '#101a22', '#0d1a23'],
  },
  shadows: { xs: 'none', sm: 'var(--elevation-menu)', md: 'var(--elevation-dialog)', lg: 'var(--elevation-dialog)', xl: 'var(--elevation-dialog)' },
  components: {
    Button: { defaultProps: { size: 'sm', fw: 500 } },
    ActionIcon: { defaultProps: { size: 36, variant: 'subtle' } },
    Select: { defaultProps: { size: 'sm', comboboxProps: { withinPortal: true } } },
    TextInput: { defaultProps: { size: 'sm' } },
    NumberInput: { defaultProps: { size: 'sm' } },
    PasswordInput: { defaultProps: { size: 'sm' } },
    Textarea: { defaultProps: { size: 'sm' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 300, multiline: true, maw: 360 } },
    Modal: { defaultProps: { radius: 'md', padding: 'lg', transitionProps: { duration: 200 } } },
    Drawer: { defaultProps: { padding: 'lg', transitionProps: { duration: 200 } } },
    Table: { defaultProps: { verticalSpacing: 'sm', horizontalSpacing: 'sm' } },
  },
});

const semanticVariables = {
  '--mantine-color-body': 'var(--paper)',
  '--mantine-color-text': 'var(--ink)',
  '--mantine-color-dimmed': 'var(--slate)',
  '--mantine-color-default': 'var(--raised)',
  '--mantine-color-default-color': 'var(--ink)',
  '--mantine-color-default-border': 'var(--control-edge)',
  '--mantine-color-default-hover': 'var(--paper)',
  '--mantine-color-placeholder': 'var(--slate)',
};
const cssVariablesResolver = () => ({ variables: {}, light: semanticVariables, dark: semanticVariables });

export function UiProvider({ children }) {
  return (
    <MantineProvider theme={workspaceTheme} defaultColorScheme="light" cssVariablesResolver={cssVariablesResolver}>
      <Notifications position="bottom-right" />
      {children}
    </MantineProvider>
  );
}
