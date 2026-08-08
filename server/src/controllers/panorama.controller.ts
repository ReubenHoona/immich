import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, StreamableFile } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { PanoramaGroupResponseDto, PanoramaGroupSearchDto, PanoramaGroupUpdateDto } from 'src/dtos/panorama.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard';
import { PanoramaService } from 'src/services/panorama.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.Panoramas)
@Controller('panoramas')
export class PanoramaController {
  constructor(private service: PanoramaService) {}

  @Get()
  @Authenticated({ permission: Permission.PanoramaRead })
  @Endpoint({
    summary: 'Retrieve panorama groups',
    description: 'Retrieve detected panorama groups for the authenticated user, best candidates first.',
    history: new HistoryBuilder().added('v3.1.0').alpha('v3.1.0'),
  })
  getPanoramas(@Auth() auth: AuthDto, @Query() dto: PanoramaGroupSearchDto): Promise<PanoramaGroupResponseDto[]> {
    return this.service.getAll(auth, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.PanoramaRead })
  @Endpoint({
    summary: 'Retrieve a panorama group',
    description: 'Retrieve a single panorama group, including its source frames.',
    history: new HistoryBuilder().added('v3.1.0').alpha('v3.1.0'),
  })
  getPanorama(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PanoramaGroupResponseDto> {
    return this.service.get(auth, id);
  }

  @Post(':id/preview')
  @Authenticated({ permission: Permission.PanoramaRead })
  @FileResponse()
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Preview a panorama',
    description:
      'Synchronously stitch the group at preview resolution and return the JPEG. Nothing is saved to the library.',
    history: new HistoryBuilder().added('v3.1.0').alpha('v3.1.0'),
  })
  previewPanorama(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<StreamableFile> {
    return this.service.preview(auth, id);
  }

  @Put(':id/stitch')
  @Authenticated({ permission: Permission.PanoramaUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Generate a panorama',
    description: 'Queue the full-quality stitch job for this group. The result is saved as a new library asset.',
    history: new HistoryBuilder().added('v3.1.0').alpha('v3.1.0'),
  })
  stitchPanorama(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.queueStitch(auth, id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.PanoramaUpdate })
  @Endpoint({
    summary: 'Update a panorama group',
    description: 'Dismiss a candidate panorama group, or restore a dismissed one.',
    history: new HistoryBuilder().added('v3.1.0').alpha('v3.1.0'),
  })
  updatePanorama(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PanoramaGroupUpdateDto,
  ): Promise<PanoramaGroupResponseDto> {
    return this.service.update(auth, id, dto);
  }
}
