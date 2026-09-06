'use client';
import { createTheme, MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';

const theme = createTheme({
  primaryColor: 'indigo',
  primaryShade: 7,
  defaultRadius: 'sm',
  fontFamily: "'IBM Plex Sans', -apple-system, sans-serif",
  fontFamilyMonospace: "'IBM Plex Mono', monospace",
  fontSizes: { xs: '13px', sm: '13px', md: '14px', lg: '16px', xl: '20px' },
  headings: { fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: '600' },
  colors: {
    indigo: [
      '#f0f2ff',
      '#e2e7ff',
      '#c6cefa',
      '#a6b3ef',
      '#8797e4',
      '#6c7ed8',
      '#566acd',
      '#455bca',
      '#354bb5',
      '#2b3e97',
    ],
  },
  components: {
    Button: { defaultProps: { size: 'compact-sm', fw: 500 } },
    Select: { defaultProps: { size: 'xs', comboboxProps: { withinPortal: true } } },
    TextInput: { defaultProps: { size: 'xs' } },
    Tooltip: { defaultProps: { withArrow: true, openDelay: 350, multiline: true, maw: 340 } },
  },
});

export function UiProvider({ children }) {
  return (
    <MantineProvider theme={theme} forceColorScheme="light">
      <Notifications position="bottom-right" />
      {children}
    </MantineProvider>
  );
}
