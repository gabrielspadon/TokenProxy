'use client';
import { useState } from 'react';
import { Badge, Group, Loader, Select, Table, Text, UnstyledButton } from '@mantine/core';
import { providerIdentity } from '@/shared/components/ProviderMark';
import { useWorkspace } from '@/shared/workspace/WorkspaceProvider';
import { useResource } from '@/shared/workspace/useResource';
import { modelsForAccounts, providerIdOf } from '@/shared/workspace/scopeOptions';
import shared from '@/shared/workspace/workspace.module.css';
import styles from './capacityViews.module.css';

const EMPTY = [];

// Every account's persisted admission verdict and model-support evidence for
// one model, without an upstream probe. The shared model scope pre-selects.
export function CapacityModelSupport({ accounts, onSelect }) {
  const { scope, models, observeSnapshot } = useWorkspace();
  const [chosenKey, setChosenKey] = useState(null);
  // Only models of providers that have an account; a model nobody can route
  // to has no admission verdict worth reading.
  const choices = modelsForAccounts(models.data?.models || EMPTY, accounts, scope.provider);
  const pairs = [
    ...new Map(
      choices.map((item) => [JSON.stringify([item.provider, item.model]), item])
    ).entries(),
  ];
  const scoped = pairs.filter(([, item]) => item.model === scope.model);
  const chosen =
    pairs.find(([key]) => key === chosenKey) || (scoped.length === 1 ? scoped[0] : null);
  const model = chosen?.[1].model;
  const provider = chosen?.[1].provider;
  const modelOptions = pairs.map(([value, item]) => ({
    value,
    label: `${providerIdentity(providerIdOf(item.provider)).name} / ${item.model}`,
  }));
  const query = new URLSearchParams({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  });
  const eligibility = useResource(model ? `/api/admin/eligibility?${query}` : null, {
    onSnapshot: observeSnapshot,
  });
  return (
    <div className={styles.support}>
      <Group justify="space-between" mb="sm">
        <div>
          <h2>Account and model evidence</h2>
          <Text size="xs" c="dimmed">
            Persisted local admission and explicit model support, without an upstream probe.
          </Text>
        </div>
        <Select
          size="xs"
          aria-label="Model to inspect"
          placeholder="Choose a model"
          searchable
          data={modelOptions}
          value={chosen?.[0] || null}
          onChange={setChosenKey}
          allowDeselect={false}
          w={300}
        />
      </Group>
      {!model ? (
        <div className={shared.emptyMessage}>
          Choose a model to compare local evidence across all accounts.
        </div>
      ) : eligibility.loading ? (
        <Loader size="xs" />
      ) : eligibility.error ? (
        <Text c="red" size="xs">
          Model evidence is unavailable. {eligibility.error}
        </Text>
      ) : (
        <Table highlightOnHover className={styles.supportTable}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Account</Table.Th>
              <Table.Th>Local admission</Table.Th>
              <Table.Th>Model support</Table.Th>
              <Table.Th>Evidence</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(eligibility.data?.accounts || EMPTY).map((account) => (
              <Table.Tr key={account.connectionId}>
                <Table.Td>
                  <UnstyledButton
                    className={styles.linkButton}
                    onClick={() => onSelect(account.connectionId)}
                  >
                    {accounts.find((item) => item.connectionId === account.connectionId)
                      ?.displayName || account.connectionId}
                  </UnstyledButton>
                </Table.Td>
                <Table.Td>
                  <Badge
                    size="sm"
                    variant="light"
                    color={
                      account.verdict === 'admissible'
                        ? 'teal'
                        : account.verdict === 'blocked'
                          ? 'orange'
                          : 'gray'
                    }
                  >
                    {account.verdict}
                  </Badge>
                </Table.Td>
                <Table.Td>{account.modelSupport?.status || 'Unknown'}</Table.Td>
                <Table.Td>
                  {account.reasons?.map((reason) => reason.label).join(' · ') ||
                    'No model-specific support evidence'}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </div>
  );
}
