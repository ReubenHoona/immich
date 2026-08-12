import { Text } from '@react-email/components';
import * as React from 'react';
import { ImmichButton } from 'src/emails/components/button.component';
import ImmichLayout from 'src/emails/components/immich.layout';
import { IntegrityIssuesEmailProps } from 'src/repositories/email.repository';
import { replaceTemplateTags } from 'src/utils/replace-template-tags';

export const IntegrityIssuesEmail = ({
  baseUrl,
  displayName,
  findings,
  total,
  customTemplate,
}: IntegrityIssuesEmailProps) => {
  const usableTemplateVariables = {
    displayName,
    findings,
    total: String(total),
    baseUrl,
  };

  const emailContent = customTemplate ? (
    replaceTemplateTags(customTemplate, usableTemplateVariables)
  ) : (
    <>
      <Text className="m-0">
        Hey <strong>{displayName}</strong>,
      </Text>

      <Text>
        The nightly integrity check found new issues in your library: <strong>{findings}</strong>.
      </Text>

      <Text>
        A missing file means the database has a record whose file is gone from disk. If the photo still exists on a
        device running the Immich app, it will be restored in place automatically on the next backup run.
      </Text>
    </>
  );

  return (
    <ImmichLayout preview={customTemplate ? emailContent.toString() : `Integrity check found: ${findings}`}>
      {emailContent}

      <ImmichButton href={`${baseUrl}/admin/maintenance`}>Review findings</ImmichButton>

      <Text className="text-xs text-gray-600">
        You are receiving this because you are the administrator of this Immich instance.
      </Text>
    </ImmichLayout>
  );
};

IntegrityIssuesEmail.PreviewProps = {
  baseUrl: 'https://demo.immich.app',
  displayName: 'Alan Turing',
  findings: '2 missing files, 1 checksum mismatch',
  total: 3,
} as IntegrityIssuesEmailProps;

export default IntegrityIssuesEmail;
