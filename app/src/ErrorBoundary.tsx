import React from 'react';
import { View } from 'react-native';
import { Button, Card, Txt } from './ui';
import { Icon } from './icons';
import { useTheme } from './theme';

function Fallback({ what, onRetry, onDismiss, detail }: { what: string; onRetry: () => void; onDismiss?: () => void; detail: string }) {
  const { t } = useTheme();
  return (
    <View accessibilityRole="alert" style={onDismiss ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60, padding: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: t.overlay } : { padding: 16, alignItems: 'center' }}>
      <Card style={{ maxWidth: 520, width: '100%', gap: 12, alignItems: 'flex-start' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="alert" size={20} color={t.serious} />
          <Txt v="h2">Something went wrong showing {what}</Txt>
        </View>
        <Txt v="small" color="muted">The service sent data this page could not read, so it was not drawn. Nothing was changed. Try again; if it keeps happening, the backend is returning malformed numbers.</Txt>
        {detail ? <Txt v="small" color="muted" selectable style={{ fontSize: 11 }}>{detail}</Txt> : null}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button kind="primary" icon="refresh" label="Try again" onPress={onRetry} />
          {onDismiss ? <Button label="Close" onPress={onDismiss} /> : null}
        </View>
      </Card>
    </View>
  );
}

/** Catches a render error below it and shows a friendly card with Retry instead of a white screen. Retry remounts the children (so they refetch). */
export class ErrorBoundary extends React.Component<{ what?: string; onDismiss?: () => void; children: React.ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { if (typeof console !== 'undefined') console.error('UI render error:', error); }
  render() {
    if (this.state.error) {
      return <Fallback what={this.props.what ?? 'this page'} detail={String(this.state.error.message || this.state.error).slice(0, 200)} onDismiss={this.props.onDismiss} onRetry={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))} />;
    }
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}
